use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use std::{fmt, result};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::api::{ApiClient, ResponseEvent, ResponseStream};
use crate::conversation::{Message, Role};
use crate::prompts;

use super::{AgentAction, RiskLevel, RuleDecision, ToolRegistry, parse_action};

const APPROVAL_REVIEW_TIMEOUT: Duration = Duration::from_secs(60);

pub trait CompletionBackend: Send + Sync {
    fn complete_stream(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<ResponseStream>;
}

impl CompletionBackend for ApiClient {
    fn complete_stream(
        &self,
        system_prompt: Option<&str>,
        messages: &[Message],
    ) -> Result<ResponseStream> {
        self.complete_stream_events(system_prompt, messages)
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
    Thinking {
        content: String,
    },
    ToolApprovalRequested {
        tool: String,
        arguments: Value,
        risk: RiskLevel,
        reason: String,
    },
    ApprovalReviewStarted {
        tool: String,
        reason: String,
    },
    ApprovalReviewFinished {
        tool: String,
        approved: bool,
        risk: RiskLevel,
        reason: String,
    },
    ToolStarted {
        tool: String,
    },
    ToolFinished {
        tool: String,
        result: String,
    },
    Final {
        content: String,
    },
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

    pub fn tool_definitions(&self) -> Vec<super::ToolDefinition> {
        self.tools.definitions()
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
            let mut response_stream = self
                .backend
                .complete_stream(Some(&self.system_prompt), &messages)?;
            let mut response = String::new();
            while let Some(event) = response_stream.recv().await {
                match event? {
                    ResponseEvent::Thinking(content) => {
                        send_event(sender, AgentEvent::Thinking { content }).await;
                    }
                    ResponseEvent::Content(content) => response.push_str(&content),
                }
            }
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
                    let requirement = self.tools.approval_requirement(&tool, &arguments);
                    let (approved, decline_reason) = match requirement.decision {
                        RuleDecision::Forbidden => (false, requirement.reason.clone()),
                        _ if approval_mode == ApprovalMode::Manual => {
                            send_event(
                                sender,
                                AgentEvent::ToolApprovalRequested {
                                    tool: tool.clone(),
                                    arguments: arguments.clone(),
                                    risk: requirement.risk,
                                    reason: requirement.reason.clone(),
                                },
                            )
                            .await;
                            let approved = approval_receiver
                                .as_mut()
                                .context("Manual approval requires an approval channel")?
                                .recv()
                                .await
                                .context("Tool approval channel closed")?;
                            (approved, "The user rejected this tool call".to_string())
                        }
                        RuleDecision::Allow => (true, String::new()),
                        RuleDecision::Review => {
                            send_event(
                                sender,
                                AgentEvent::ApprovalReviewStarted {
                                    tool: tool.clone(),
                                    reason: requirement.reason.clone(),
                                },
                            )
                            .await;
                            let outcome = self
                                .review_tool(
                                    &messages,
                                    &tool,
                                    &arguments,
                                    requirement.risk,
                                    &requirement.reason,
                                )
                                .await;
                            send_event(
                                sender,
                                AgentEvent::ApprovalReviewFinished {
                                    tool: tool.clone(),
                                    approved: outcome.approved,
                                    risk: outcome.risk,
                                    reason: outcome.reason.clone(),
                                },
                            )
                            .await;
                            (outcome.approved, outcome.reason)
                        }
                    };

                    let result = if approved {
                        send_event(sender, AgentEvent::ToolStarted { tool: tool.clone() }).await;
                        match self.tools.execute(&tool, arguments).await {
                            Ok(result) => result,
                            Err(error) => format!("ERROR: {error:#}"),
                        }
                    } else {
                        format!("DECLINED: {decline_reason}.")
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

    async fn review_tool(
        &self,
        messages: &[Message],
        tool: &str,
        arguments: &Value,
        rule_risk: RiskLevel,
        rule_reason: &str,
    ) -> ReviewOutcome {
        match self
            .try_review_tool(messages, tool, arguments, rule_risk, rule_reason)
            .await
        {
            Ok(outcome) => outcome,
            Err(error) => ReviewOutcome {
                approved: false,
                risk: rule_risk.max(RiskLevel::High),
                reason: format!("Automatic approval review failed closed: {error:#}"),
            },
        }
    }

    async fn try_review_tool(
        &self,
        messages: &[Message],
        tool: &str,
        arguments: &Value,
        rule_risk: RiskLevel,
        rule_reason: &str,
    ) -> Result<ReviewOutcome> {
        let user_context = messages
            .iter()
            .filter(|message| {
                message.role == Role::User && !message.content.starts_with("The tool `")
            })
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>();
        let request = serde_json::to_string_pretty(&serde_json::json!({
            "user_authorization_context": user_context,
            "proposed_action": {"tool": tool, "arguments": arguments},
            "rule_risk_floor": rule_risk,
            "rule_reason": rule_reason,
        }))?;
        let mut stream = self.backend.complete_stream(
            Some(prompts::approval_reviewer()),
            &[Message::user(request)],
        )?;
        let response = tokio::time::timeout(APPROVAL_REVIEW_TIMEOUT, async {
            let mut response = String::new();
            while let Some(event) = stream.recv().await {
                if let ResponseEvent::Content(content) = event? {
                    response.push_str(&content);
                }
            }
            Result::<String>::Ok(response)
        })
        .await
        .context("Automatic approval review timed out")??;

        let verdict: ReviewerVerdict = serde_json::from_str(strip_json_fence(&response))
            .context("Reviewer returned invalid JSON")?;
        let risk = rule_risk.max(verdict.risk);
        let approved = verdict.decision == ReviewDecision::Allow
            && match risk {
                RiskLevel::Low | RiskLevel::Medium => true,
                RiskLevel::High => verdict.authorization == UserAuthorization::Explicit,
                RiskLevel::Critical => false,
            };
        let reason = if approved {
            verdict.reason
        } else if verdict.decision == ReviewDecision::Allow {
            format!(
                "Reviewer approval did not meet the {risk}-risk authorization threshold: {}",
                verdict.reason
            )
        } else {
            verdict.reason
        };
        Ok(ReviewOutcome {
            approved,
            risk,
            reason,
        })
    }
}

#[derive(Debug)]
struct ReviewOutcome {
    approved: bool,
    risk: RiskLevel,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ReviewerVerdict {
    decision: ReviewDecision,
    risk: RiskLevel,
    authorization: UserAuthorization,
    reason: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ReviewDecision {
    Allow,
    Deny,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum UserAuthorization {
    Explicit,
    Implicit,
    None,
}

fn strip_json_fence(response: &str) -> &str {
    let trimmed = response.trim();
    let trimmed = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    trimmed.strip_suffix("```").unwrap_or(trimmed).trim()
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
        responses: Arc<Mutex<VecDeque<Vec<ResponseEvent>>>>,
        requests: Arc<Mutex<Vec<Vec<Message>>>>,
    }

    impl MockBackend {
        fn new(responses: &[&str]) -> Self {
            Self {
                responses: Arc::new(Mutex::new(
                    responses
                        .iter()
                        .map(|value| vec![ResponseEvent::Content(value.to_string())])
                        .collect(),
                )),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn with_events(responses: Vec<Vec<ResponseEvent>>) -> Self {
            Self {
                responses: Arc::new(Mutex::new(responses.into())),
                requests: Arc::new(Mutex::new(Vec::new())),
            }
        }
    }

    impl CompletionBackend for MockBackend {
        fn complete_stream(
            &self,
            system_prompt: Option<&str>,
            messages: &[Message],
        ) -> Result<ResponseStream> {
            assert!(!system_prompt.unwrap().is_empty());
            self.requests.lock().unwrap().push(messages.to_vec());
            let events = self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("mock response queue exhausted");
            let (sender, receiver) = mpsc::channel(events.len().max(1));
            for event in events {
                sender.try_send(Ok(event)).unwrap();
            }
            Ok(receiver)
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

    #[tokio::test]
    async fn forwards_thinking_before_final_event() {
        let workspace = TestWorkspace::new();
        let backend = MockBackend::with_events(vec![vec![
            ResponseEvent::Thinking("considering".to_string()),
            ResponseEvent::Content(r#"{"type":"final","content":"done"}"#.to_string()),
        ]]);
        let tools =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(false)).unwrap();
        let runner = AgentRunner::new(backend, tools, 2).unwrap();
        let mut run = runner.start(vec![Message::user("task")]);

        assert_eq!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::Thinking {
                content: "considering".to_string()
            }
        );
        assert_eq!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::Final {
                content: "done".to_string()
            }
        );
    }

    #[tokio::test]
    async fn auto_mode_reviews_unknown_commands_and_honors_denial() {
        let workspace = TestWorkspace::new();
        let backend = MockBackend::new(&[
            r#"{"type":"tool_call","tool":"run_command","arguments":{"command":"python task.py"}}"#,
            r#"{"decision":"deny","risk":"high","authorization":"none","reason":"Not authorized by the user"}"#,
            r#"{"type":"final","content":"command denied"}"#,
        ]);
        let tools =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(true)).unwrap();
        let runner = AgentRunner::new(backend, tools, 4).unwrap();
        let mut run = runner.start(vec![Message::user("Inspect the project")]);

        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::ApprovalReviewStarted { .. }
        ));
        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::ApprovalReviewFinished {
                approved: false,
                risk: RiskLevel::High,
                ..
            }
        ));
        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::ToolFinished { ref result, .. } if result.contains("DECLINED")
        ));
        assert!(matches!(
            run.receiver.recv().await.unwrap().unwrap(),
            AgentEvent::Final { .. }
        ));
    }

    #[tokio::test]
    async fn high_risk_auto_review_requires_explicit_authorization() {
        let workspace = TestWorkspace::new();
        let backend = MockBackend::new(&[
            r#"{"decision":"allow","risk":"high","authorization":"implicit","reason":"Seems related"}"#,
        ]);
        let tools =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(true)).unwrap();
        let runner = AgentRunner::new(backend, tools, 2).unwrap();

        let outcome = runner
            .review_tool(
                &[Message::user("Inspect the project")],
                "run_command",
                &serde_json::json!({"command": "git reset --hard HEAD"}),
                RiskLevel::High,
                "Git command can discard changes",
            )
            .await;

        assert!(!outcome.approved);
        assert_eq!(outcome.risk, RiskLevel::High);
    }

    #[tokio::test]
    async fn invalid_auto_review_response_fails_closed() {
        let workspace = TestWorkspace::new();
        let backend = MockBackend::new(&["not-json"]);
        let tools =
            ToolRegistry::new(&workspace.0, ToolPermissions::workspace_write(true)).unwrap();
        let runner = AgentRunner::new(backend, tools, 2).unwrap();

        let outcome = runner
            .review_tool(
                &[Message::user("Run the helper")],
                "run_command",
                &serde_json::json!({"command": "python task.py"}),
                RiskLevel::Medium,
                "Unknown command",
            )
            .await;

        assert!(!outcome.approved);
        assert_eq!(outcome.risk, RiskLevel::High);
        assert!(outcome.reason.contains("failed closed"));
    }
}
