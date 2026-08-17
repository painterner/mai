use anyhow::{Context, Result};
use crossterm::{
    event::{
        self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyModifiers, MouseButton,
        MouseEvent, MouseEventKind,
    },
    execute,
};
use ratatui::{DefaultTerminal, layout::Rect};
use std::fmt;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::agent::{AgentEvent, AgentRun, AgentRunner, ApprovalMode, RiskLevel, ToolPermissions};
use crate::api::{ApiClient, ResponseEvent, ResponseStream};
use crate::cli::Args;
use crate::config::Config;
use crate::conversation::{Message, Role as ConversationRole};
use crate::prompts;
use crate::session::{PersistedSession, SessionStore, SessionSummary};
use crate::ui;

/// Chat message for display
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    pub is_streaming: bool,
    pub collapsed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    User,
    Assistant,
    Thinking,
    System,
    Tool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatMode {
    Chat,
    Agent,
}

impl fmt::Display for ChatMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Chat => formatter.write_str("chat"),
            Self::Agent => formatter.write_str("agent"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub tool: String,
    pub arguments: String,
}

#[derive(Debug, Clone)]
pub struct SessionPicker {
    pub sessions: Vec<SessionSummary>,
    /// Zero selects "start a new session"; persisted sessions start at one.
    pub selected: usize,
}

enum ActiveResponse {
    Chat(ResponseStream),
    Agent(AgentRun),
}

enum ResponseUpdate {
    Text(String),
    Thinking(String),
    ToolApprovalRequested {
        tool: String,
        arguments: serde_json::Value,
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
    ToolStarted(String),
    ToolFinished {
        tool: String,
        result: String,
    },
    Final(String),
    Error(anyhow::Error),
    Disconnected,
    Empty,
}

impl ActiveResponse {
    fn try_recv(&mut self) -> ResponseUpdate {
        match self {
            Self::Chat(receiver) => match receiver.try_recv() {
                Ok(Ok(ResponseEvent::Content(chunk))) => ResponseUpdate::Text(chunk),
                Ok(Ok(ResponseEvent::Thinking(chunk))) => ResponseUpdate::Thinking(chunk),
                Ok(Err(error)) => ResponseUpdate::Error(error),
                Err(mpsc::error::TryRecvError::Disconnected) => ResponseUpdate::Disconnected,
                Err(mpsc::error::TryRecvError::Empty) => ResponseUpdate::Empty,
            },
            Self::Agent(run) => match run.try_recv() {
                Ok(Ok(AgentEvent::Thinking { content })) => ResponseUpdate::Thinking(content),
                Ok(Ok(AgentEvent::ToolApprovalRequested {
                    tool,
                    arguments,
                    risk,
                    reason,
                })) => ResponseUpdate::ToolApprovalRequested {
                    tool,
                    arguments,
                    risk,
                    reason,
                },
                Ok(Ok(AgentEvent::ApprovalReviewStarted { tool, reason })) => {
                    ResponseUpdate::ApprovalReviewStarted { tool, reason }
                }
                Ok(Ok(AgentEvent::ApprovalReviewFinished {
                    tool,
                    approved,
                    risk,
                    reason,
                })) => ResponseUpdate::ApprovalReviewFinished {
                    tool,
                    approved,
                    risk,
                    reason,
                },
                Ok(Ok(AgentEvent::ToolStarted { tool })) => ResponseUpdate::ToolStarted(tool),
                Ok(Ok(AgentEvent::ToolFinished { tool, result })) => {
                    ResponseUpdate::ToolFinished { tool, result }
                }
                Ok(Ok(AgentEvent::Final { content })) => ResponseUpdate::Final(content),
                Ok(Err(error)) => ResponseUpdate::Error(error),
                Err(mpsc::error::TryRecvError::Disconnected) => ResponseUpdate::Disconnected,
                Err(mpsc::error::TryRecvError::Empty) => ResponseUpdate::Empty,
            },
        }
    }
}

/// Application state
pub struct App {
    /// Current input buffer
    pub input: String,
    /// Cursor position in input
    pub cursor_pos: usize,
    /// Chat history for display
    pub messages: Vec<ChatMessage>,
    /// API conversation history
    pub api_history: Vec<Message>,
    /// Current scroll offset (from bottom)
    pub scroll_offset: u16,
    /// Is the app running?
    pub running: bool,
    /// Is currently waiting for response?
    pub waiting: bool,
    /// Status message
    pub status: String,
    /// Current interaction mode
    pub mode: ChatMode,
    /// Tool execution approval mode
    pub approval_mode: ApprovalMode,
    /// Tool call currently waiting for manual approval
    pub pending_approval: Option<PendingApproval>,
    /// Config
    pub config: Config,
    /// API client
    api: ApiClient,
    /// Agent executor
    agent: AgentRunner,
    /// Active chat stream or agent task
    response: Option<ActiveResponse>,
    /// Current model name
    pub model: String,
    /// Startup/session-command restore picker.
    pub session_picker: Option<SessionPicker>,
    session_store: SessionStore,
    session_created_at: String,
}

impl App {
    pub fn new(config: Config, args: Args) -> Result<Self> {
        let workspace =
            std::env::current_dir().context("Failed to determine workspace directory")?;
        let session_store = SessionStore::for_workspace(&workspace)?;
        Self::new_with_session_store(config, args, workspace, session_store)
    }

    pub(crate) fn new_with_session_store(
        config: Config,
        args: Args,
        workspace: std::path::PathBuf,
        session_store: SessionStore,
    ) -> Result<Self> {
        let shell_enabled = args.shell_enabled();
        let model = args.model.unwrap_or_else(|| config.model.clone());
        let mut api = ApiClient::new(&config)?;
        api.set_model(&model);
        let mode = if args.agent {
            ChatMode::Agent
        } else {
            ChatMode::Chat
        };
        let agent = AgentRunner::in_workspace(
            api.clone(),
            workspace,
            ToolPermissions::workspace_write(shell_enabled),
            args.agent_max_steps,
        )?;

        let sessions = session_store.list()?;
        let session_picker = (!sessions.is_empty()).then_some(SessionPicker {
            sessions,
            selected: 0,
        });

        let mut app = Self {
            input: String::new(),
            cursor_pos: 0,
            messages: Vec::new(),
            api_history: Vec::new(),
            scroll_offset: 0,
            running: true,
            waiting: false,
            status: String::new(),
            mode,
            approval_mode: ApprovalMode::Auto,
            pending_approval: None,
            config,
            api,
            agent,
            response: None,
            model: model.clone(),
            session_picker,
            session_store,
            session_created_at: crate::session::now(),
        };

        app.add_welcome_message();

        Ok(app)
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(config: Config, args: Args) -> Result<Self> {
        let workspace =
            std::env::current_dir().context("Failed to determine workspace directory")?;
        let root = std::env::temp_dir().join(format!(
            "{}-app-test-{}-{}",
            crate::APP_NAME,
            std::process::id(),
            rand::random::<u64>()
        ));
        let session_store = SessionStore::at(root, &workspace)?;
        Self::new_with_session_store(config, args, workspace, session_store)
    }

    fn add_welcome_message(&mut self) {
        self.messages.push(ChatMessage {
            role: Role::System,
            content: format!(
                "✨ {} v{} | Provider: {} | Model: {} | Mode: {} / {} | Type /help for commands",
                crate::APP_NAME,
                env!("CARGO_PKG_VERSION"),
                self.config.provider,
                self.model,
                self.mode,
                self.approval_mode
            ),
            is_streaming: false,
            collapsed: false,
        });
    }

    /// Main application loop
    pub async fn run(&mut self) -> Result<()> {
        let mut terminal = ratatui::init();
        if let Err(error) = execute!(std::io::stdout(), EnableMouseCapture) {
            ratatui::restore();
            return Err(error).context("Failed to enable terminal mouse capture");
        }
        let result = self.event_loop(&mut terminal).await;
        let mouse_result = execute!(std::io::stdout(), DisableMouseCapture)
            .context("Failed to disable terminal mouse capture");
        ratatui::restore();
        result?;
        mouse_result
    }

    async fn event_loop(&mut self, terminal: &mut DefaultTerminal) -> Result<()> {
        while self.running {
            // Draw UI
            terminal.draw(|frame| ui::draw(frame, self))?;

            let update = self
                .response
                .as_mut()
                .map(ActiveResponse::try_recv)
                .unwrap_or(ResponseUpdate::Empty);
            match update {
                ResponseUpdate::Text(chunk) => {
                    self.finish_thinking();
                    self.append_assistant_text(&chunk);
                    continue;
                }
                ResponseUpdate::Thinking(chunk) => {
                    self.append_thinking_text(&chunk);
                    self.status = "Thinking...".to_string();
                    continue;
                }
                ResponseUpdate::ToolApprovalRequested {
                    tool,
                    arguments,
                    risk,
                    reason,
                } => {
                    self.finish_thinking();
                    self.status =
                        format!("Approve {tool} ({risk})? Enter/Y: approve | Esc/N: reject");
                    let arguments = serde_json::to_string_pretty(&arguments)
                        .unwrap_or_else(|_| arguments.to_string());
                    self.pending_approval = Some(PendingApproval {
                        tool,
                        arguments: format!("risk: {risk}\nreason: {reason}\n{arguments}"),
                    });
                    continue;
                }
                ResponseUpdate::ApprovalReviewStarted { tool, reason } => {
                    self.finish_thinking();
                    self.status = format!("Auto-reviewing {tool}: {reason}");
                    continue;
                }
                ResponseUpdate::ApprovalReviewFinished {
                    tool,
                    approved,
                    risk,
                    reason,
                } => {
                    self.status = format!(
                        "Auto-review {} {tool} ({risk}): {reason}",
                        if approved { "approved" } else { "denied" }
                    );
                    continue;
                }
                ResponseUpdate::ToolStarted(tool) => {
                    self.finish_thinking();
                    self.status = format!("Agent running tool: {tool}");
                    continue;
                }
                ResponseUpdate::ToolFinished { tool, result } => {
                    self.finish_thinking();
                    self.add_tool_message(&tool, &result);
                    self.status = format!("Agent completed tool: {tool}");
                    continue;
                }
                ResponseUpdate::Final(content) => {
                    self.finish_thinking();
                    self.append_assistant_text(&content);
                    self.finish_response();
                    continue;
                }
                ResponseUpdate::Error(error) => {
                    self.fail_response(&error);
                }
                ResponseUpdate::Disconnected => self.finish_response(),
                ResponseUpdate::Empty => {}
            }

            // Poll for keyboard events (non-blocking)
            if event::poll(Duration::from_millis(16))? {
                match event::read()? {
                    Event::Key(key) => self.handle_key(key).await?,
                    Event::Mouse(mouse) => self.handle_mouse(mouse)?,
                    _ => {}
                }
            }
        }

        Ok(())
    }

    fn append_assistant_text(&mut self, text: &str) {
        if let Some(last) = self.messages.last_mut()
            && last.role == Role::Assistant
            && last.is_streaming
        {
            last.content.push_str(text);
        }
    }

    fn append_thinking_text(&mut self, text: &str) {
        if let Some(message) = self
            .messages
            .iter_mut()
            .rev()
            .find(|message| message.role == Role::Thinking && message.is_streaming)
        {
            message.content.push_str(text);
            return;
        }

        let insert_at = self.messages.len().saturating_sub(1);
        self.messages.insert(
            insert_at,
            ChatMessage {
                role: Role::Thinking,
                content: text.to_string(),
                is_streaming: true,
                collapsed: false,
            },
        );
    }

    fn finish_thinking(&mut self) {
        for message in self
            .messages
            .iter_mut()
            .filter(|message| message.role == Role::Thinking && message.is_streaming)
        {
            message.is_streaming = false;
            message.collapsed = true;
        }
    }

    pub fn toggle_latest_thinking(&mut self) {
        let index = self
            .messages
            .iter()
            .enumerate()
            .rev()
            .find_map(|(index, message)| (message.role == Role::Thinking).then_some(index));
        if let Some(index) = index {
            self.toggle_thinking(index);
        } else {
            self.status = "No thinking content available.".to_string();
        }
    }

    pub fn toggle_thinking(&mut self, index: usize) {
        let Some(message) = self.messages.get_mut(index) else {
            return;
        };
        if message.role != Role::Thinking || message.is_streaming {
            return;
        }
        message.collapsed = !message.collapsed;
        self.status = if message.collapsed {
            "Thinking collapsed.".to_string()
        } else {
            "Thinking expanded.".to_string()
        };
    }

    fn add_tool_message(&mut self, tool: &str, result: &str) {
        let insert_at = self.messages.len().saturating_sub(1);
        self.messages.insert(
            insert_at,
            ChatMessage {
                role: Role::Tool,
                content: format!("{tool}\n{}", truncate(result, 2_000)),
                is_streaming: false,
                collapsed: false,
            },
        );
    }

    fn finish_response(&mut self) {
        self.finish_thinking();
        if let Some(last) = self.messages.last_mut()
            && last.is_streaming
        {
            last.is_streaming = false;
            if !last.content.is_empty() {
                self.api_history
                    .push(Message::assistant(last.content.clone()));
            }
        }
        self.response = None;
        self.pending_approval = None;
        self.waiting = false;
        self.status = String::new();
        self.persist_or_report();
    }

    fn fail_response(&mut self, error: &anyhow::Error) {
        self.finish_thinking();
        if let Some(last) = self.messages.last_mut()
            && last.role == Role::Assistant
            && last.is_streaming
        {
            last.content = format!("Error: {error}");
            last.is_streaming = false;
        }
        self.response = None;
        self.pending_approval = None;
        self.waiting = false;
        self.status = format!("Error: {error}");
    }

    pub fn set_chat_mode(&mut self, mode: ChatMode) {
        if self.waiting {
            self.status = "Cannot switch mode while a response is running.".to_string();
            return;
        }
        self.mode = mode;
        self.status = format!("{} mode enabled.", capitalize(&mode.to_string()));
    }

    pub fn toggle_chat_mode(&mut self) {
        let mode = match self.mode {
            ChatMode::Chat => ChatMode::Agent,
            ChatMode::Agent => ChatMode::Chat,
        };
        self.set_chat_mode(mode);
    }

    pub fn set_approval_mode(&mut self, mode: ApprovalMode) {
        if self.waiting {
            self.status = "Cannot switch approval mode while a response is running.".to_string();
            return;
        }
        self.approval_mode = mode;
        self.status = format!("Tool approval mode: {mode}.");
    }

    pub fn toggle_approval_mode(&mut self) {
        let mode = match self.approval_mode {
            ApprovalMode::Auto => ApprovalMode::Manual,
            ApprovalMode::Manual => ApprovalMode::Auto,
        };
        self.set_approval_mode(mode);
    }

    pub fn respond_to_pending_approval(&mut self, approved: bool) {
        let Some(pending) = self.pending_approval.as_ref() else {
            return;
        };
        let tool = pending.tool.clone();
        let Some(ActiveResponse::Agent(run)) = self.response.as_ref() else {
            self.status = "No active agent is waiting for approval.".to_string();
            return;
        };

        match run.respond_to_approval(approved) {
            Ok(()) => {
                self.pending_approval = None;
                self.status = if approved {
                    format!("Approved tool: {tool}")
                } else {
                    format!("Rejected tool: {tool}")
                };
            }
            Err(error) => {
                self.status = format!("Failed to respond to approval: {error}");
            }
        }
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) -> Result<()> {
        if self.session_picker.is_some() {
            return Ok(());
        }
        match mouse.kind {
            MouseEventKind::ScrollUp => {
                self.scroll_offset = self.scroll_offset.saturating_add(3);
            }
            MouseEventKind::ScrollDown => {
                self.scroll_offset = self.scroll_offset.saturating_sub(3);
            }
            MouseEventKind::Down(MouseButton::Left) => {
                let (width, height) =
                    crossterm::terminal::size().context("Failed to read terminal dimensions")?;
                let frame_area = Rect::new(0, 0, width, height);
                if let Some(index) =
                    ui::thinking_message_at(frame_area, self, mouse.column, mouse.row)
                {
                    self.toggle_thinking(index);
                    return Ok(());
                }
                match ui::input_control_at(
                    frame_area,
                    mouse.column,
                    mouse.row,
                    self.pending_approval.is_some(),
                ) {
                    Some(ui::InputControl::Chat) => self.set_chat_mode(ChatMode::Chat),
                    Some(ui::InputControl::Agent) => self.set_chat_mode(ChatMode::Agent),
                    Some(ui::InputControl::Auto) => self.set_approval_mode(ApprovalMode::Auto),
                    Some(ui::InputControl::Manual) => self.set_approval_mode(ApprovalMode::Manual),
                    Some(ui::InputControl::Approve) => self.respond_to_pending_approval(true),
                    Some(ui::InputControl::Reject) => self.respond_to_pending_approval(false),
                    None => {}
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn handle_key(&mut self, key: event::KeyEvent) -> Result<()> {
        if self.session_picker.is_some() {
            return self.handle_session_picker_key(key);
        }

        match (key.modifiers, key.code) {
            // Quit
            (KeyModifiers::CONTROL, KeyCode::Char('c')) => {
                if self.waiting {
                    // Cancel streaming
                    self.finish_response();
                    self.status = "Cancelled.".to_string();
                } else {
                    self.running = false;
                }
            }
            (KeyModifiers::CONTROL, KeyCode::Char('d')) => {
                self.running = false;
            }

            // Manual tool approval
            (_, KeyCode::Enter | KeyCode::Char('y')) if self.pending_approval.is_some() => {
                self.respond_to_pending_approval(true);
            }
            (_, KeyCode::Esc | KeyCode::Char('n')) if self.pending_approval.is_some() => {
                self.respond_to_pending_approval(false);
            }

            // Mode shortcuts
            (_, KeyCode::F(2)) => self.toggle_chat_mode(),
            (_, KeyCode::F(3)) => self.toggle_approval_mode(),
            (_, KeyCode::F(4)) => self.toggle_latest_thinking(),

            // Submit input
            (_, KeyCode::Enter) => {
                if !self.input.is_empty() && !self.waiting {
                    self.submit().await?;
                }
            }

            // Ctrl shortcuts (must be before generic Char match)
            (KeyModifiers::CONTROL, KeyCode::Char('a')) => {
                self.cursor_pos = 0;
            }
            (KeyModifiers::CONTROL, KeyCode::Char('e')) => {
                self.cursor_pos = self.input.len();
            }
            (KeyModifiers::CONTROL, KeyCode::Char('u')) => {
                self.input.clear();
                self.cursor_pos = 0;
            }

            // Input editing
            (_, KeyCode::Char(c)) if !self.waiting => {
                self.input.insert(self.cursor_pos, c);
                self.cursor_pos += c.len_utf8();
            }
            (_, KeyCode::Backspace) if !self.waiting => {
                if self.cursor_pos > 0 {
                    let prev = self.input[..self.cursor_pos]
                        .chars()
                        .last()
                        .map(|c| c.len_utf8())
                        .unwrap_or(0);
                    self.cursor_pos -= prev;
                    self.input.remove(self.cursor_pos);
                }
            }
            (_, KeyCode::Delete) if !self.waiting => {
                if self.cursor_pos < self.input.len() {
                    self.input.remove(self.cursor_pos);
                }
            }
            (_, KeyCode::Left) if !self.waiting => {
                if self.cursor_pos > 0 {
                    let prev = self.input[..self.cursor_pos]
                        .chars()
                        .last()
                        .map(|c| c.len_utf8())
                        .unwrap_or(0);
                    self.cursor_pos -= prev;
                }
            }
            (_, KeyCode::Right) if !self.waiting => {
                if self.cursor_pos < self.input.len() {
                    let next = self.input[self.cursor_pos..]
                        .chars()
                        .next()
                        .map(|c| c.len_utf8())
                        .unwrap_or(0);
                    self.cursor_pos += next;
                }
            }
            (_, KeyCode::Home) if !self.waiting => {
                self.cursor_pos = 0;
            }
            (_, KeyCode::End) if !self.waiting => {
                self.cursor_pos = self.input.len();
            }

            // Scroll
            (_, KeyCode::PageUp) => {
                self.scroll_offset = self.scroll_offset.saturating_add(10);
            }
            (_, KeyCode::PageDown) => {
                self.scroll_offset = self.scroll_offset.saturating_sub(10);
            }

            _ => {}
        }

        Ok(())
    }

    fn handle_session_picker_key(&mut self, key: event::KeyEvent) -> Result<()> {
        let item_count = self
            .session_picker
            .as_ref()
            .map(|picker| picker.sessions.len() + 1)
            .unwrap_or(1);
        match (key.modifiers, key.code) {
            (KeyModifiers::CONTROL, KeyCode::Char('c'))
            | (KeyModifiers::CONTROL, KeyCode::Char('d')) => self.running = false,
            (_, KeyCode::Esc | KeyCode::Char('n')) => {
                self.session_picker = None;
                self.status = "Started a new session.".to_string();
            }
            (_, KeyCode::Up | KeyCode::Char('k')) => {
                if let Some(picker) = self.session_picker.as_mut() {
                    picker.selected = if picker.selected == 0 {
                        item_count - 1
                    } else {
                        picker.selected - 1
                    };
                }
            }
            (_, KeyCode::Down | KeyCode::Char('j')) => {
                if let Some(picker) = self.session_picker.as_mut() {
                    picker.selected = (picker.selected + 1) % item_count;
                }
            }
            (_, KeyCode::Enter) => {
                let selected = self
                    .session_picker
                    .as_ref()
                    .map(|picker| picker.selected)
                    .unwrap_or(0);
                if selected == 0 {
                    self.session_picker = None;
                    self.status = "Started a new session.".to_string();
                } else if let Some(id) = self
                    .session_picker
                    .as_ref()
                    .and_then(|picker| picker.sessions.get(selected - 1))
                    .map(|session| session.id.clone())
                {
                    self.restore_session(&id)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn restore_session(&mut self, id: &str) -> Result<()> {
        let session = self.session_store.load(id)?;
        self.api.restore_session(session.id.clone());
        self.api_history = session.messages;
        self.session_created_at = session.created_at;
        self.messages.clear();
        self.add_welcome_message();
        self.messages
            .extend(self.api_history.iter().map(|message| ChatMessage {
                role: match message.role {
                    ConversationRole::User => Role::User,
                    ConversationRole::Assistant => Role::Assistant,
                },
                content: message.content.clone(),
                is_streaming: false,
                collapsed: false,
            }));
        self.scroll_offset = 0;
        self.session_picker = None;
        self.status = format!("Restored session {}.", short_session_id(&session.id));
        Ok(())
    }

    fn show_session_picker(&mut self) -> Result<()> {
        let sessions = self.session_store.list()?;
        if sessions.is_empty() {
            self.status = "No saved sessions for this directory.".to_string();
        } else {
            self.session_picker = Some(SessionPicker {
                sessions,
                selected: 0,
            });
        }
        Ok(())
    }

    fn persist_or_report(&mut self) {
        if self.api_history.is_empty() {
            return;
        }
        let session = PersistedSession::new(
            self.api.session_id(),
            self.session_store.workspace(),
            self.session_created_at.clone(),
            self.api_history.clone(),
        );
        if let Err(error) = self.session_store.save(&session) {
            tracing::warn!("Failed to save session: {error:#}");
            self.status = format!("Session save failed: {error}");
        }
    }

    async fn submit(&mut self) -> Result<()> {
        let input = self.input.clone();
        self.input.clear();
        self.cursor_pos = 0;
        self.scroll_offset = 0;

        // Handle slash commands
        if input.starts_with('/') {
            return self.handle_command(&input);
        }

        // Add user message
        self.messages.push(ChatMessage {
            role: Role::User,
            content: input.clone(),
            is_streaming: false,
            collapsed: false,
        });

        // Add to API history
        self.api_history.push(Message::user(input.clone()));

        // Start streaming response
        self.waiting = true;
        self.status = "Thinking...".to_string();
        self.persist_or_report();

        // Add placeholder for assistant response
        self.messages.push(ChatMessage {
            role: Role::Assistant,
            content: String::new(),
            is_streaming: true,
            collapsed: false,
        });

        let response = match self.mode {
            ChatMode::Chat => self
                .api
                .complete_stream_events(Some(prompts::chat_system()), &self.api_history)
                .map(ActiveResponse::Chat),
            ChatMode::Agent => Ok(ActiveResponse::Agent(
                self.agent
                    .start_with_approval(self.api_history.clone(), self.approval_mode),
            )),
        };
        match response {
            Ok(response) => self.response = Some(response),
            Err(error) => self.fail_response(&error),
        }

        Ok(())
    }

    fn handle_command(&mut self, cmd: &str) -> Result<()> {
        let parts: Vec<&str> = cmd.splitn(2, ' ').collect();
        match parts[0] {
            "/help" | "/h" => {
                self.messages.push(ChatMessage {
                    role: Role::System,
                    content: [
                        "📋 Available commands:",
                        "  /help, /h     - Show this help",
                        "  /clear, /c    - Clear chat history",
                        "  /sessions, /s - Restore a session for this directory",
                        "  /model <name> - Switch model",
                        "  /agent on|off - Switch chat/agent mode",
                        "  /approval auto|manual - Set tool approval mode",
                        "  /tools        - Show currently enabled Agent tools",
                        "  /thinking     - Expand/collapse latest thinking",
                        "  /config       - Show current config",
                        "  /quit, /q     - Exit",
                    ]
                    .join("\n"),
                    is_streaming: false,
                    collapsed: false,
                });
            }
            "/clear" | "/c" => {
                self.messages.clear();
                self.api_history.clear();
                self.api.start_new_session();
                self.session_created_at = crate::session::now();
                self.add_welcome_message();
                self.status = "Chat cleared. Started a new session.".to_string();
            }
            "/sessions" | "/session" | "/s" => self.show_session_picker()?,
            "/model" | "/m" => {
                if let Some(model) = parts.get(1) {
                    self.model = model.to_string();
                    self.api.set_model(model);
                    self.status = format!("Switched to model: {model}");
                } else {
                    self.status = format!("Current model: {}", self.model);
                }
            }
            "/agent" | "/a" => match parts.get(1).map(|value| value.trim()) {
                Some("on" | "agent") => self.set_chat_mode(ChatMode::Agent),
                Some("off" | "chat") => self.set_chat_mode(ChatMode::Chat),
                Some(value) => {
                    self.status = format!("Invalid agent mode '{value}'; use on or off");
                }
                None => {
                    self.status = format!("Current mode: {}", self.mode);
                }
            },
            "/approval" => match parts.get(1).map(|value| value.trim()) {
                Some("auto") => self.set_approval_mode(ApprovalMode::Auto),
                Some("manual") => self.set_approval_mode(ApprovalMode::Manual),
                Some(value) => {
                    self.status = format!("Invalid approval mode '{value}'; use auto or manual");
                }
                None => {
                    self.status = format!("Current approval mode: {}", self.approval_mode);
                }
            },
            "/tools" => {
                let tools = self
                    .agent
                    .tool_definitions()
                    .into_iter()
                    .map(|tool| format!("  {} - {}", tool.name, tool.description))
                    .collect::<Vec<_>>()
                    .join("\n");
                self.messages.push(ChatMessage {
                    role: Role::System,
                    content: format!("🧰 Available Agent tools:\n{tools}"),
                    is_streaming: false,
                    collapsed: false,
                });
            }
            "/thinking" | "/think" => self.toggle_latest_thinking(),
            "/config" => {
                self.messages.push(ChatMessage {
                    role: Role::System,
                    content: format!(
                        "⚙️ Configuration:\n  Provider: {}\n  Model: {}\n  Mode: {}\n  Approval: {}\n  Session ID: {}\n  Base URL: {}\n  Max tokens: {}\n  Temperature: {}",
                        self.config.provider,
                        self.model,
                        self.mode,
                        self.approval_mode,
                        self.api.session_id(),
                        self.config.base_url,
                        self.config.max_tokens,
                        self.config.temperature
                    ),
                    is_streaming: false,
                    collapsed: false,
                });
            }
            "/quit" | "/q" => {
                self.running = false;
            }
            _ => {
                self.status = format!("Unknown command: {}", parts[0]);
            }
        }
        Ok(())
    }
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}\n(output truncated)")
    } else {
        truncated
    }
}

fn short_session_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_app() -> App {
        App::new_for_test(
            Config::default(),
            Args {
                prompt: None,
                model: None,
                provider: None,
                agent: false,
                agent_max_steps: 12,
                allow_shell: false,
                no_shell: true,
                debug: false,
            },
        )
        .unwrap()
    }

    #[test]
    fn thinking_chunks_collapse_without_entering_api_history() {
        let mut app = test_app();
        app.append_thinking_text("first ");
        app.append_thinking_text("second");

        let thinking = app
            .messages
            .iter()
            .find(|message| message.role == Role::Thinking)
            .unwrap();
        assert_eq!(thinking.content, "first second");
        assert!(thinking.is_streaming);
        assert!(!thinking.collapsed);
        assert!(app.api_history.is_empty());

        app.finish_thinking();
        let thinking = app
            .messages
            .iter()
            .find(|message| message.role == Role::Thinking)
            .unwrap();
        assert!(!thinking.is_streaming);
        assert!(thinking.collapsed);

        app.append_thinking_text("next step");
        assert_eq!(
            app.messages
                .iter()
                .filter(|message| message.role == Role::Thinking)
                .count(),
            2
        );
    }

    #[test]
    fn clear_starts_a_new_http_session() {
        let mut app = test_app();
        let previous = app.api.session_id();
        app.api_history.push(Message::user("old conversation"));

        app.handle_command("/clear").unwrap();

        assert!(app.api_history.is_empty());
        assert_ne!(app.api.session_id(), previous);
        assert!(app.status.contains("new session"));
    }

    #[test]
    fn selected_session_restores_history_and_http_session_id() {
        let mut app = test_app();
        let session_id = "12345678-1234-4234-8234-123456789abc";
        let saved = PersistedSession::new(
            session_id,
            app.session_store.workspace(),
            "2026-08-17T12:00:00Z",
            vec![
                Message::user("saved question"),
                Message::assistant("saved answer"),
            ],
        );
        app.session_store.save(&saved).unwrap();

        app.show_session_picker().unwrap();
        app.session_picker.as_mut().unwrap().selected = 1;
        app.handle_session_picker_key(event::KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();

        assert!(app.session_picker.is_none());
        assert_eq!(app.api.session_id(), session_id);
        assert_eq!(app.api_history, saved.messages);
        assert!(app.messages.iter().any(|message| {
            message.role == Role::Assistant && message.content == "saved answer"
        }));
    }

    #[test]
    fn tools_command_lists_only_currently_enabled_tools() {
        let mut app = test_app();
        app.handle_command("/tools").unwrap();
        let without_shell = &app.messages.last().unwrap().content;
        assert!(without_shell.contains("read_file"));
        assert!(without_shell.contains("write_file"));
        assert!(!without_shell.contains("run_command"));

        let mut app = App::new_for_test(
            Config::default(),
            Args {
                prompt: None,
                model: None,
                provider: None,
                agent: true,
                agent_max_steps: 12,
                allow_shell: true,
                no_shell: false,
                debug: false,
            },
        )
        .unwrap();
        app.handle_command("/tools").unwrap();
        assert!(app.messages.last().unwrap().content.contains("run_command"));
    }
}
