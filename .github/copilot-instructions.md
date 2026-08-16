# maicli - Copilot Instructions

## Project Overview
- **Language**: Rust (edition 2024)
- **Binary name**: `maicli`
- **TUI Framework**: Ratatui + Crossterm
- **Async Runtime**: Tokio
- **HTTP Client**: Reqwest with rustls TLS backend

## Architecture
- `src/main.rs` - Entry point, initializes logging, parses args, launches TUI or single-prompt mode
- `src/cli.rs` - CLI argument definitions using Clap derive
- `src/config.rs` - TOML config file management with env var overrides
- `src/api.rs` - Gemini API client supporting both streaming (SSE) and non-streaming requests
- `src/app.rs` - Application state, event loop, input handling, slash commands
- `src/ui.rs` - Ratatui terminal UI rendering (header, messages, status bar, input)
- `src/markdown.rs` - Simple markdown to styled terminal text renderer

## Build Commands
- `cargo build` - Debug build
- `cargo build --release` - Release build (with LTO + strip)
- `cargo run` - Run in development mode
- `GEMINI_API_KEY=xxx cargo run` - Run with API key

## Key Dependencies
- `ratatui` (0.29) - Terminal UI framework
- `crossterm` (0.28) - Cross-platform terminal handling
- `reqwest` (0.12) - HTTP client with rustls
- `reqwest-eventsource` (0.6) - Server-Sent Events for streaming
- `tokio` (1.x) - Async runtime
- `clap` (4.x) - CLI argument parser
- `serde` + `serde_json` + `toml` - Config serialization
- `syntect` (5.x) - Syntax highlighting
- `pulldown-cmark` (0.12) - Markdown parsing

## Development Guidelines
- Use `anyhow::Result` for error handling in application code
- Use `thiserror` for library-style error types
- Prefer streaming API for interactive mode
- Keep UI rendering in `ui.rs`, state management in `app.rs`
- Config supports both file (`~/.config/maicli/config.toml`) and env vars
