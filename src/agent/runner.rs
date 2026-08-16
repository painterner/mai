use std::path::Path;
use std::sync::Arc;
use std::{fmt, result};

use anyhow::{Context, Result, bail};
use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::api::ApiClient;
use crate::conversation::Message;
use crate::prompts;

use super::{AgentAction, ToolRegistry, parse_action};

pub trait CompletionBackend: Send + Sync {
    fn complete<'a>(
        &'a self,
        system_prompt: Option<&'a str>,
        messages: &'a [Message],
    ) -> BoxFuture<'a, Result<String>>;
}

impl CompletionBackend for ApiClient {
    fn complete<'a>(
        &'a self,
        system_prompt: Option<&'a str>,
        messages: &'a [Message],
    ) -> BoxFuture<'a, Result<String>> {
        async move { ApiClient::complete(self, system_prompt, messages).await }.boxed()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ApprovalMode {
    #[default]
    Auto,
    Manual,
}

impl fmt::Display for ApprovalMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Auto => formatter.write_str("auto"),
            Self::Manual => formatter.write_str("manual"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentEvent {
    ToolApprovalRequested { tool: String, arguments: Value },
    ToolStarted { tool: String },
    ToolFinished { tool: String, result: String },
    Final { content: String },
}

pub struct AgentRun {
    receiver: mpsc::Receiver<Result<AgentEvent>>,
    approval_sender: mpsc::Sender<bool>,
    task: JoinHandle<()>,
}

impl AgentRun {
    pub fn try_recv(&mut self) -> result::Result<Result<AgentEvent>, mpsc::error::TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn respond_to_approval(&self, approved: bool) -> Result<()> {
        self.approval_sender
            .try_send(approved)
            .context("Agent is not waiting for tool approval")
    }
}

impl Drop for AgentRun {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
pub struct AgentRunner {
    backend: Arc<dyn CompletionBackend>,
    tools: ToolRegistry,
    system_prompt: String,
    max_steps: usize,
}

impl AgentRunner {
    pub fn in_workspace(
        backend: impl CompletionBackend + 'static,
        workspace: impl AsRef<Path>,
        permissions: super::ToolPermissions,
        max_steps: usize,
    ) -> Result<Self> {
        Self::new(
            backend,
            ToolRegistry::new(workspace, permissions)?,
            max_steps,
        )
    }

    pub fn new(
        backend: impl CompletionBackend + 'static,
        tools: ToolRegistry,
        max_steps: usize,
    ) -> Result<Self> {
        if max_steps == 0 {
            bail!("Agent max steps must be greater than zero");
        }
        let system_prompt = prompts::agent_system(tools.workspace(), &tools.definitions_json());
        Ok(Self {
            backend: Arc::new(backend),
            tools,
            system_prompt,
            max_steps,
        })
    }

    pub fn start(&self, messages: Vec<Message>) -> AgentRun {
        self.start_with_approval(messages, ApprovalMode::Auto)
    }

    pub fn start_with_approval(
        &self,
        messages: Vec<Message>,
        approval_mode: ApprovalMode,
    ) -> AgentRun {
        let (sender, receiver) = mpsc::channel(32);
        let (approval_sender, mut approval_receiver) = mpsc::channel(1);
        let runner = self.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = runner
                .run_with_events(messages, approval_mode, &sender, &mut approval_receiver)
                .await
            {
                let _ = sender.send(Err(error)).await;
            }
        });
        AgentRun {
            receiver,
            approval_sender,
            task,
        }
    }

    pub async fn run(&self, messages: Vec<Message>) -> Result<String> {
        self.run_loop(messages, ApprovalMode::Auto, None, None)
            .await
    }

    async fn run_with_events(
        &self,
        messages: Vec<Message>,
        approval_mode: ApprovalMode,
        sender: &mpsc::Sender<Result<AgentEvent>>,
        approval_receiver: &mut mpsc::Receiver<bool>,
    ) -> Result<String> {
        self.run_loop(
            messages,
            approval_mode,
            Some(sender),
            Some(approval_receiver),
        )
        .await
    }

    async fn run_loop(
        &self,
        mut messages: Vec<Message>,
        approval_mode: ApprovalMode,
        sender: Option<&mpsc::Sender<Result<AgentEvent>>>,
        mut approval_receiver: Option<&mut mpsc::Receiver<bool>>,
    ) -> Result<String> {
        if messages.is_empty() {
            bail!("Agent requires at least one user message");
        }

        for _ in 0..self.max_steps {
            let response = self
                .backend
                .complete(Some(&self.system_prompt), &messages)
                .await?;
            let action = match parse_action(&response) {
                Ok(action) => action,
                Err(error) => {
                    messages.push(Message::assistant(response));
                    messages.push(Message::user(prompts::protocol_error(&error.to_string())));
                    continue;
                }
            };
            messages.push(Message::assistant(response));

            match action {
                AgentAction::ToolCall { tool, arguments } => {
                    let approved = if approval_mode == ApprovalMode::Manual {
                        send_event(
                            sender,
                            AgentEvent::ToolApprovalRequested {
                                tool: tool.clone(),
                                arguments: arguments.clone(),
                            },
                        )
                        .await;
                        approval_receiver
                            .as_mut()
                            .context("Manual approval requires an approval channel")?
                            .recv()
                            .await
                            .context("Tool approval channel closed")?
                    } else {
                        true
                    };

                    let result = if approved {
                        send_event(sender, AgentEvent::ToolStarted { tool: tool.clone() }).await;
                        match self.tools.execute(&tool, arguments).await {
                            Ok(result) => result,
                            Err(error) => format!("ERROR: {error:#}"),
                        }
                    } else {
                        "DECLINED: The user rejected this tool call.".to_string()
                    };
                    send_event(
                        sender,
                        AgentEvent::ToolFinished {
                            tool: tool.clone(),
                            result: result.clone(),
                        },
                    )
                    .await;
                    messages.push(Message::user(prompts::tool_result(&tool, &result)));
                }
                AgentAction::Final { content } => {
                    send_event(
                        sender,
                        AgentEvent::Final {
                            content: content.clone(),
                        },
                    )
                    .await;
                    return Ok(content);
                }
            }
        }

        bail!(
            "Agent stopped after {} steps without a final response",
            self.max_steps
        )
    }
}

async fn send_event(sender: Option<&mpsc::Sender<Result<AgentEvent>>>, event: AgentEvent) {
    if let Some(sender) = sender {
        let _ = sender.send(Ok(event)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::agent::ToolPermissions;

    #[derive(Clone)]
    struct MockBackend {
        responses: Arc<Mutex<VecDeque<String>>>,
        requests: Arc<Mutex<Vec<Vec<Message>>>>,
    }

    impl MockBackend {
        fn new(responses: &[&str]) -> Self {
            Self {
                responses: Arc::new(Mutex::new(
                    responses.iter().map(|value| value.to_string()).collect(),
                )),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl CompletionBackend for MockBackend {
        fn complete<'a>(
            &'a self,
            system_prompt: Option<&'a str>,
            messages: &'a [Message],
        ) -> BoxFuture<'a, Result<String>> {
            assert!(system_prompt.unwrap().contains("list_files"));
            self.requests.lock().unwrap().push(messages.to_vec());
            let response = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("mock response queue exhausted");
            async move { Ok(response) }.boxed()
        }
    }

    struct TestWorkspace(PathBuf);

    impl TestWorkspace {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "{}-runner-test-{}-{unique}",
                crate::APP_NAME,
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn executes_tool_and_returns_final_response() {
        let workspace = TestWorkspace::new();
        fs::write(workspace.0.join("README.md"), "hello").unwrap();
        let backend = MockBackend::new(&[
            r#"{"type":"tool_call","tool":"list_files","arguments":{"path":"."}}"#,
            r#"{"type":"final","content":"Found README.md"}"#,
        ]);
        let tools =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(false)).unwrap();
        let runner = AgentRunner::new(backend.clone(), tools, 4).unwrap();

        let result = runner
            .run(vec![Message::user("Inspect files")])
            .await
            .unwrap();

        assert_eq!(result, "Found README.md");
        let requests = backend.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].last().unwrap().content.contains("README.md"));
    }

    #[tokio::test]
    async fn retries_after_invalid_protocol_response() {
        let workspace = TestWorkspace::new();
        let backend = MockBackend::new(&["not json", r#"{"type":"final","content":"recovered"}"#]);
        let tools =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(false)).unwrap();
        let runner = AgentRunner::new(backend.clone(), tools, 3).unwrap();

        let result = runner.run(vec![Message::user("task")]).await.unwrap();

        assert_eq!(result, "recovered");
        let requests = backend.requests.lock().unwrap();
        assert!(
            requests[1]
                .last()
                .unwrap()
                .content
                .contains("not a valid agent action")
        );
    }

    #[tokio::test]
    async fn manual_mode_waits_for_approval_before_running_tool() {
        let workspace = TestWorkspace::new();
        let backend = MockBackend::new(&[
            r#"{"type":"tool_call","tool":"write_file","arguments":{"path":"result.txt","content":"approved"}}"#,
            r#"{"type":"final","content":"done"}"#,
        ]);
        let tools =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(false)).unwrap();
        let runner = AgentRunner::new(backend, tools, 3).unwrap();
        let mut run =
            runner.start_with_approval(vec![Message::user("Create a file")], ApprovalMode::Manual);

        let event = run.receiver.recv().await.unwrap().unwrap();
        assert!(matches!(
            event,
            AgentEvent::ToolApprovalRequested { ref tool, .. } if tool == "write_file"
        ));
        assert!(!workspace.0.join("result.txt").exists());

        run.respond_to_approval(true).unwrap();
        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::ToolStarted { .. }
        ));
        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::ToolFinished { .. }
        ));
        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::Final { .. }
        ));
        assert_eq!(
            fs::read_to_string(workspace.0.join("result.txt")).unwrap(),
            "approved"
        );
    }

    #[tokio::test]
    async fn manual_mode_reports_rejected_tool_without_running_it() {
        let workspace = TestWorkspace::new();
        let backend = MockBackend::new(&[
            r#"{"type":"tool_call","tool":"write_file","arguments":{"path":"result.txt","content":"blocked"}}"#,
            r#"{"type":"final","content":"request rejected"}"#,
        ]);
        let tools =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(false)).unwrap();
        let runner = AgentRunner::new(backend.clone(), tools, 3).unwrap();
        let mut run =
            runner.start_with_approval(vec![Message::user("Create a file")], ApprovalMode::Manual);

        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::ToolApprovalRequested { .. }
        ));
        run.respond_to_approval(false).unwrap();
        let event = run.receiver.recv().await.unwrap().unwrap();
        assert!(matches!(
            event,
            AgentEvent::ToolFinished { ref result, .. } if result.contains("DECLINED")
        ));
        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::Final { .. }
        ));
        assert!(!workspace.0.join("result.txt").exists());
        assert!(
            backend.requests.lock().unwrap()[1]
                .last()
                .unwrap()
                .content
                .contains("DECLINED")
        );
    }
}
