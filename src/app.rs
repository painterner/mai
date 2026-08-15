use anyhow::{Context, Result};
use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use ratatui::DefaultTerminal;
use std::fmt;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::agent::{AgentEvent, AgentRun, AgentRunner, ToolPermissions};
use crate::api::ApiClient;
use crate::cli::Args;
use crate::config::Config;
use crate::conversation::Message;
use crate::prompts;
use crate::ui;

/// Chat message for display
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    pub is_streaming: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    User,
    Assistant,
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

enum ActiveResponse {
    Chat(mpsc::Receiver<Result<String>>),
    Agent(AgentRun),
}

enum ResponseUpdate {
    Text(String),
    ToolStarted(String),
    ToolFinished { tool: String, result: String },
    Final(String),
    Error(anyhow::Error),
    Disconnected,
    Empty,
}

impl ActiveResponse {
    fn try_recv(&mut self) -> ResponseUpdate {
        match self {
            Self::Chat(receiver) => match receiver.try_recv() {
                Ok(Ok(chunk)) => ResponseUpdate::Text(chunk),
                Ok(Err(error)) => ResponseUpdate::Error(error),
                Err(mpsc::error::TryRecvError::Disconnected) => ResponseUpdate::Disconnected,
                Err(mpsc::error::TryRecvError::Empty) => ResponseUpdate::Empty,
            },
            Self::Agent(run) => match run.try_recv() {
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
}

impl App {
    pub fn new(config: Config, args: Args) -> Result<Self> {
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
            std::env::current_dir().context("Failed to determine workspace directory")?,
            ToolPermissions::workspace_write(args.allow_shell),
            args.agent_max_steps,
        )?;

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
            config,
            api,
            agent,
            response: None,
            model: model.clone(),
        };

        // Welcome message
        app.messages.push(ChatMessage {
            role: Role::System,
            content: format!(
                "✨ Gemini CLI v{} | Provider: {} | Model: {} | Mode: {} | Type /help for commands",
                env!("CARGO_PKG_VERSION"),
                app.config.provider,
                model,
                app.mode
            ),
            is_streaming: false,
        });

        Ok(app)
    }

    /// Main application loop
    pub async fn run(&mut self) -> Result<()> {
        let mut terminal = ratatui::init();
        let result = self.event_loop(&mut terminal).await;
        ratatui::restore();
        result
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
                    self.append_assistant_text(&chunk);
                    continue;
                }
                ResponseUpdate::ToolStarted(tool) => {
                    self.status = format!("Agent running tool: {tool}");
                    continue;
                }
                ResponseUpdate::ToolFinished { tool, result } => {
                    self.add_tool_message(&tool, &result);
                    self.status = format!("Agent completed tool: {tool}");
                    continue;
                }
                ResponseUpdate::Final(content) => {
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
            if event::poll(Duration::from_millis(16))?
                && let Event::Key(key) = event::read()?
            {
                self.handle_key(key).await?;
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

    fn add_tool_message(&mut self, tool: &str, result: &str) {
        let insert_at = self.messages.len().saturating_sub(1);
        self.messages.insert(
            insert_at,
            ChatMessage {
                role: Role::Tool,
                content: format!("{tool}\n{}", truncate(result, 2_000)),
                is_streaming: false,
            },
        );
    }

    fn finish_response(&mut self) {
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
        self.waiting = false;
        self.status = String::new();
    }

    fn fail_response(&mut self, error: &anyhow::Error) {
        if let Some(last) = self.messages.last_mut()
            && last.role == Role::Assistant
            && last.is_streaming
        {
            last.content = format!("Error: {error}");
            last.is_streaming = false;
        }
        self.response = None;
        self.waiting = false;
        self.status = format!("Error: {error}");
    }

    async fn handle_key(&mut self, key: event::KeyEvent) -> Result<()> {
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
            (_, KeyCode::Char(c)) => {
                self.input.insert(self.cursor_pos, c);
                self.cursor_pos += c.len_utf8();
            }
            (_, KeyCode::Backspace) => {
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
            (_, KeyCode::Delete) => {
                if self.cursor_pos < self.input.len() {
                    self.input.remove(self.cursor_pos);
                }
            }
            (_, KeyCode::Left) => {
                if self.cursor_pos > 0 {
                    let prev = self.input[..self.cursor_pos]
                        .chars()
                        .last()
                        .map(|c| c.len_utf8())
                        .unwrap_or(0);
                    self.cursor_pos -= prev;
                }
            }
            (_, KeyCode::Right) => {
                if self.cursor_pos < self.input.len() {
                    let next = self.input[self.cursor_pos..]
                        .chars()
                        .next()
                        .map(|c| c.len_utf8())
                        .unwrap_or(0);
                    self.cursor_pos += next;
                }
            }
            (_, KeyCode::Home) => {
                self.cursor_pos = 0;
            }
            (_, KeyCode::End) => {
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
        });

        // Add to API history
        self.api_history.push(Message::user(input.clone()));

        // Start streaming response
        self.waiting = true;
        self.status = "Thinking...".to_string();

        // Add placeholder for assistant response
        self.messages.push(ChatMessage {
            role: Role::Assistant,
            content: String::new(),
            is_streaming: true,
        });

        let response = match self.mode {
            ChatMode::Chat => self
                .api
                .complete_stream(Some(prompts::chat_system()), &self.api_history)
                .map(ActiveResponse::Chat),
            ChatMode::Agent => Ok(ActiveResponse::Agent(
                self.agent.start(self.api_history.clone()),
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
                        "  /model <name> - Switch model",
                        "  /agent on|off - Switch chat/agent mode",
                        "  /config       - Show current config",
                        "  /quit, /q     - Exit",
                    ]
                    .join("\n"),
                    is_streaming: false,
                });
            }
            "/clear" | "/c" => {
                self.messages.clear();
                self.api_history.clear();
                self.status = "Chat cleared.".to_string();
            }
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
                Some("on" | "agent") => {
                    self.mode = ChatMode::Agent;
                    self.status = "Agent mode enabled.".to_string();
                }
                Some("off" | "chat") => {
                    self.mode = ChatMode::Chat;
                    self.status = "Chat mode enabled.".to_string();
                }
                Some(value) => {
                    self.status = format!("Invalid agent mode '{value}'; use on or off");
                }
                None => {
                    self.status = format!("Current mode: {}", self.mode);
                }
            },
            "/config" => {
                self.messages.push(ChatMessage {
                    role: Role::System,
                    content: format!(
                        "⚙️ Configuration:\n  Provider: {}\n  Model: {}\n  Mode: {}\n  Base URL: {}\n  Max tokens: {}\n  Temperature: {}",
                        self.config.provider,
                        self.model,
                        self.mode,
                        self.config.base_url,
                        self.config.max_tokens,
                        self.config.temperature
                    ),
                    is_streaming: false,
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

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}\n(output truncated)")
    } else {
        truncated
    }
}
