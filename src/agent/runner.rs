use std::path::Path;
use std::sync::Arc;

use anyhow::{Result, bail};
use futures::FutureExt;
use futures::future::BoxFuture;
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentEvent {
    ToolStarted { tool: String },
    ToolFinished { tool: String, result: String },
    Final { content: String },
}

pub struct AgentRun {
    receiver: mpsc::Receiver<Result<AgentEvent>>,
    task: JoinHandle<()>,
}

impl AgentRun {
    pub fn try_recv(
        &mut self,
    ) -> std::result::Result<Result<AgentEvent>, mpsc::error::TryRecvError> {
        self.receiver.try_recv()
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
        let (sender, receiver) = mpsc::channel(32);
        let runner = self.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = runner.run_with_events(messages, &sender).await {
                let _ = sender.send(Err(error)).await;
            }
        });
        AgentRun { receiver, task }
    }

    pub async fn run(&self, messages: Vec<Message>) -> Result<String> {
        self.run_loop(messages, None).await
    }

    async fn run_with_events(
        &self,
        messages: Vec<Message>,
        sender: &mpsc::Sender<Result<AgentEvent>>,
    ) -> Result<String> {
        self.run_loop(messages, Some(sender)).await
    }

    async fn run_loop(
        &self,
        mut messages: Vec<Message>,
        sender: Option<&mpsc::Sender<Result<AgentEvent>>>,
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
                    send_event(sender, AgentEvent::ToolStarted { tool: tool.clone() }).await;
                    let result = match self.tools.execute(&tool, arguments).await {
                        Ok(result) => result,
                        Err(error) => format!("ERROR: {error:#}"),
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
                "gemini-cli-runner-test-{}-{unique}",
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
}
