# Gemini CLI (Rust)

A blazing-fast terminal-based AI assistant built with Rust + Ratatui. It supports
the OpenAI-compatible Chat Completions API by default, with optional native
Gemini API support.

## Features

- ⚡ **Instant startup** (~50ms vs ~3s for Node.js-based CLIs)
- 💬 **Interactive TUI** with Ratatui - full terminal UI with scrolling, colors, and keyboard navigation
- 🔄 **Streaming responses** - see AI responses appear in real-time via SSE
- 📝 **Markdown rendering** - code blocks, headers, bold, italic, inline code
- 🤖 **Agent mode** - inspect, search, and edit files through a bounded tool loop
- ⚙️ **Configurable** - TOML config file + environment variable overrides
- 🔑 **Simple auth** - just set `OPENAI_API_KEY` and go
- 🔌 **Two API protocols** - native Gemini and OpenAI-compatible `/chat/completions`

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (1.85+)
- An API key for OpenAI or an OpenAI-compatible service (not needed for local
  servers that do not require authentication)

### Build & Run

```bash
# Build
cargo build --release

# Set your API key
export OPENAI_API_KEY="your-api-key-here"

# Run interactive mode
./target/release/gemini

# Or single prompt mode
./target/release/gemini -p "Explain Rust ownership in 3 sentences"

# Run an agent task against the current workspace
./target/release/gemini --agent -p "Inspect the project and update its README"
```

Alternatively, create a local `.env` file from the included template:

```bash
cp .env.example .env
# Edit .env, then run normally
cargo run -- -p "Hello"
```

The CLI loads `.env` automatically at startup. Existing shell environment
variables take precedence over values in `.env`, and `.env` is ignored by Git
to avoid committing secrets.

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

### Agent Mode

Agent mode gives the model a reusable tool loop for the current working
directory:

```bash
# File inspection, search, and workspace edits
gemini --agent -p "Find duplicated error handling and refactor it"

# Also allow build and test commands
gemini --agent --allow-shell -p "Fix the failing tests and verify the result"

# Limit the number of model/tool turns
gemini --agent --agent-max-steps 6 -p "Summarize this project"
```

The default tools are `list_files`, `read_file`, `search_files`, `write_file`,
and `replace_in_file`. File paths are restricted to the current workspace;
absolute paths, parent traversal, and symlink escapes are rejected.

Shell execution is disabled by default. `--allow-shell` enables
`run_command`, which can execute arbitrary commands with the same permissions
as the CLI and is not an operating-system sandbox. Enable it only for a
workspace and model you trust.

In interactive mode, start with `gemini --agent` or switch at runtime with
`/agent on` and `/agent off`. Tool results are shown separately from the model
conversation.

The input border has two clickable segmented controls in its upper-right
corner:

- `Chat / Agent` switches the conversation mode.
- `Auto / Manual` controls tool approval. Auto executes Agent tool calls
  immediately. Manual pauses before every tool call and replaces the mode
  controls with clickable `Approve / Reject` actions.

Mode controls are disabled while a response is running. Manual approval is an
interactive TUI feature; single-prompt Agent runs remain automatic.

### CLI Options

| Flag | Description |
|------|-------------|
| `-p, --prompt <TEXT>` | Send a single prompt (non-interactive) |
| `-m, --model <NAME>` | Model to use (default: gpt-4o-mini) |
| `--provider <gemini\|openai>` | API protocol to use |
| `--agent` | Enable workspace Agent mode |
| `--agent-max-steps <N>` | Maximum model/tool turns (default: 12) |
| `--allow-shell` | Allow Agent mode to run shell commands |
| `-d, --debug` | Enable debug logging |

### Slash Commands (Interactive Mode)

| Command | Description |
|---------|-------------|
| `/help`, `/h` | Show available commands |
| `/clear`, `/c` | Clear chat history |
| `/model <name>`, `/m` | Switch model |
| `/agent on\|off`, `/a on\|off` | Switch between Agent and chat modes |
| `/approval auto\|manual` | Set Agent tool approval behavior |
| `/config` | Show current configuration |
| `/quit`, `/q` | Exit |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `F2` | Switch between Chat and Agent |
| `F3` | Switch between Auto and Manual approval |
| `Enter` / `Y` | Approve a pending Manual tool call |
| `Esc` / `N` | Reject a pending Manual tool call |
| `Ctrl+C` | Cancel stream / Quit |
| `Ctrl+D` | Quit |
| `Ctrl+U` | Clear input |
| `Ctrl+A` | Move cursor to start |
| `Ctrl+E` | Move cursor to end |
| `PageUp/Down` | Scroll messages |

The mouse can click all input-border controls and use the wheel to scroll the
conversation.

## Configuration

Config file location: `~/.config/gemini-cli/config.toml`

```toml
provider = "openai"
api_key = "your-api-key"
model = "gpt-4o-mini"
base_url = "https://api.openai.com/v1"
max_tokens = 8192
temperature = 0.7
```

### OpenAI-compatible API (default)

The client calls `{base_url}/chat/completions` and supports both regular and SSE
streaming responses.

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

### Native Gemini API (optional)

To use Gemini's native protocol instead, configure:

```toml
provider = "gemini"
api_key = "your-gemini-api-key"
model = "gemini-2.0-flash"
base_url = "https://generativelanguage.googleapis.com/v1beta"
```

### Environment Variables

These variables can be exported by the shell or placed in `.env`:

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
prompts/
├── chat_system.md      # Normal chat system prompt
├── agent_system.md     # Agent behavior and action protocol
├── tool_result.md      # Tool-result continuation prompt
└── protocol_error.md   # Invalid-action recovery prompt
src/
├── agent/
│   ├── mod.rs          # Public Agent API
│   ├── protocol.rs     # Structured model-action parsing
│   ├── runner.rs       # Reusable model/tool execution loop
│   └── tools.rs        # Workspace tools and permission boundary
├── lib.rs              # Reusable library surface
├── main.rs             # Binary entry point and mode selection
├── conversation.rs     # Provider-neutral message types
├── prompts.rs          # Compile-time Prompt resource loader
├── cli.rs              # Clap CLI argument definitions
├── config.rs           # TOML config loading + env overrides
├── api.rs              # Gemini + OpenAI-compatible API adapter
├── app.rs              # Application state and event loop
├── ui.rs               # Ratatui TUI rendering
└── markdown.rs         # Markdown to styled terminal text
```

The crate exposes `ApiClient`, `Message`, `AgentRunner`, `CompletionBackend`,
and the tool registry for reuse. Prompt files are embedded at compile time, so
rebuild the binary after changing them.

## License

MIT
