use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use ratatui::DefaultTerminal;
use std::time::Duration;
use tokio::sync::mpsc;

use crate::api::{ApiClient, Message, Part};
use crate::cli::Args;
use crate::config::Config;
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
    /// Config
    pub config: Config,
    /// API client
    api: ApiClient,
    /// Stream receiver for current response
    stream_rx: Option<mpsc::Receiver<Result<String>>>,
    /// Current model name
    pub model: String,
}

impl App {
    pub fn new(config: Config, args: Args) -> Result<Self> {
        let model = args.model.unwrap_or_else(|| config.model.clone());
        let mut api = ApiClient::new(&config)?;
        api.set_model(&model);

        let mut app = Self {
            input: String::new(),
            cursor_pos: 0,
            messages: Vec::new(),
            api_history: Vec::new(),
            scroll_offset: 0,
            running: true,
            waiting: false,
            status: String::new(),
            config,
            api,
            stream_rx: None,
            model: model.clone(),
        };

        // Welcome message
        app.messages.push(ChatMessage {
            role: Role::System,
            content: format!(
                "✨ Gemini CLI v{} | Provider: {} | Model: {} | Type /help for commands",
                env!("CARGO_PKG_VERSION"),
                app.config.provider,
                model
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

            // Check for streaming data
            if let Some(rx) = &mut self.stream_rx {
                match rx.try_recv() {
                    Ok(Ok(chunk)) => {
                        // Append chunk to last message
                        if let Some(last) = self.messages.last_mut()
                            && last.role == Role::Assistant
                            && last.is_streaming
                        {
                            last.content.push_str(&chunk);
                        }
                        continue;
                    }
                    Ok(Err(e)) => {
                        // Stream error
                        self.finish_streaming();
                        self.status = format!("Error: {e}");
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => {
                        // Stream complete
                        self.finish_streaming();
                    }
                    Err(mpsc::error::TryRecvError::Empty) => {
                        // No data yet, continue
                    }
                }
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

    fn finish_streaming(&mut self) {
        if let Some(last) = self.messages.last_mut()
            && last.is_streaming
        {
            last.is_streaming = false;
            // Add to API history
            self.api_history.push(Message {
                role: "model".to_string(),
                parts: vec![Part {
                    text: last.content.clone(),
                }],
            });
        }
        self.stream_rx = None;
        self.waiting = false;
        self.status = String::new();
    }

    async fn handle_key(&mut self, key: event::KeyEvent) -> Result<()> {
        match (key.modifiers, key.code) {
            // Quit
            (KeyModifiers::CONTROL, KeyCode::Char('c')) => {
                if self.waiting {
                    // Cancel streaming
                    self.stream_rx = None;
                    self.finish_streaming();
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
        self.api_history.push(Message {
            role: "user".to_string(),
            parts: vec![Part {
                text: input.clone(),
            }],
        });

        // Start streaming response
        self.waiting = true;
        self.status = "Thinking...".to_string();

        // Add placeholder for assistant response
        self.messages.push(ChatMessage {
            role: Role::Assistant,
            content: String::new(),
            is_streaming: true,
        });

        match self
            .api
            .chat_stream(&input, &self.api_history[..self.api_history.len() - 1])
        {
            Ok(rx) => {
                self.stream_rx = Some(rx);
            }
            Err(e) => {
                self.waiting = false;
                self.status = format!("Error: {e}");
                if let Some(last) = self.messages.last_mut() {
                    last.content = format!("❌ Error: {e}");
                    last.is_streaming = false;
                }
            }
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
            "/config" => {
                self.messages.push(ChatMessage {
                    role: Role::System,
                    content: format!(
                        "⚙️ Configuration:\n  Provider: {}\n  Model: {}\n  Base URL: {}\n  Max tokens: {}\n  Temperature: {}",
                        self.config.provider,
                        self.model,
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
