# Gemini CLI (Rust)

A blazing-fast terminal-based AI assistant built with Rust + Ratatui. It supports
both the native Gemini API and OpenAI-compatible Chat Completions APIs.

## Features

- ⚡ **Instant startup** (~50ms vs ~3s for Node.js-based CLIs)
- 💬 **Interactive TUI** with Ratatui - full terminal UI with scrolling, colors, and keyboard navigation
- 🔄 **Streaming responses** - see AI responses appear in real-time via SSE
- 📝 **Markdown rendering** - code blocks, headers, bold, italic, inline code
- ⚙️ **Configurable** - TOML config file + environment variable overrides
- 🔑 **Simple auth** - just set `GEMINI_API_KEY` and go
- 🔌 **Two API protocols** - native Gemini and OpenAI-compatible `/chat/completions`

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (1.85+)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

### Build & Run

```bash
# Build
cargo build --release

# Set your API key
export GEMINI_API_KEY="your-api-key-here"

# Run interactive mode
./target/release/gemini

# Or single prompt mode
./target/release/gemini -p "Explain Rust ownership in 3 sentences"
```

### Install globally

```bash
cargo install --path .
```

## Usage

### Interactive Mode

```
gemini
```

Opens a full TUI chat interface. Type messages and press Enter to send.

### Single Prompt

```
gemini -p "What is the Rust borrow checker?"
```

### CLI Options

| Flag | Description |
|------|-------------|
| `-p, --prompt <TEXT>` | Send a single prompt (non-interactive) |
| `-m, --model <NAME>` | Model to use (default: gemini-2.0-flash) |
| `--provider <gemini\|openai>` | API protocol to use |
| `-d, --debug` | Enable debug logging |

### Slash Commands (Interactive Mode)

| Command | Description |
|---------|-------------|
| `/help`, `/h` | Show available commands |
| `/clear`, `/c` | Clear chat history |
| `/model <name>`, `/m` | Switch model |
| `/config` | Show current configuration |
| `/quit`, `/q` | Exit |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Ctrl+C` | Cancel stream / Quit |
| `Ctrl+D` | Quit |
| `Ctrl+U` | Clear input |
| `Ctrl+A` | Move cursor to start |
| `Ctrl+E` | Move cursor to end |
| `PageUp/Down` | Scroll messages |

## Configuration

Config file location: `~/.config/gemini-cli/config.toml`

```toml
provider = "gemini"
api_key = "your-api-key"
model = "gemini-2.0-flash"
base_url = "https://generativelanguage.googleapis.com/v1beta"
max_tokens = 8192
temperature = 0.7
```

### OpenAI-compatible API

Set `provider = "openai"`. The client calls `{base_url}/chat/completions` and
supports both regular and SSE streaming responses.

```toml
provider = "openai"
api_key = "your-api-key"
model = "gpt-4o-mini"
base_url = "https://api.openai.com/v1"
max_tokens = 8192
temperature = 0.7
```

For a compatible proxy or local server, replace `base_url` and `model`. The API
key can be empty when the server does not require authentication:

```toml
provider = "openai"
api_key = ""
model = "your-model"
base_url = "http://localhost:8000/v1"
```

You can also select the protocol for one invocation:

```bash
API_PROVIDER=openai OPENAI_API_KEY="your-api-key" \
  gemini --provider openai --model gpt-4o-mini -p "Hello"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | API key (overrides config) |
| `GEMINI_MODEL` | Model name (overrides config) |
| `GEMINI_BASE_URL` | API base URL (overrides config) |
| `API_PROVIDER` | API protocol: `gemini` or `openai` |
| `OPENAI_API_KEY` | API key in OpenAI mode |
| `OPENAI_MODEL` | Model name in OpenAI mode |
| `OPENAI_BASE_URL` | Base URL in OpenAI mode; usually ends in `/v1` |

## Project Structure

```
src/
├── main.rs       # Entry point, CLI argument handling
├── cli.rs        # Clap CLI argument definitions
├── config.rs     # TOML config loading + env overrides
├── api.rs        # Gemini + OpenAI-compatible clients (streaming + non-streaming)
├── app.rs        # Application state & event loop
├── ui.rs         # Ratatui TUI rendering
└── markdown.rs   # Markdown → styled terminal text
```

## License

MIT
