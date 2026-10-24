# maicli

A blazing-fast terminal-based AI assistant built with Rust + Ratatui. It supports
the OpenAI-compatible Chat Completions API by default, with optional native
Gemini API support.

## Features

- ⚡ **Instant startup** (~50ms vs ~3s for Node.js-based CLIs)
- 💬 **Interactive TUI** with Ratatui - full terminal UI with scrolling, colors, and keyboard navigation
- 🔄 **Streaming responses** - see AI responses appear in real-time via SSE
- 🧠 **Collapsible thinking** - stream provider reasoning separately from answers
- 📝 **Markdown rendering** - code blocks, headers, bold, italic, inline code
- 🤖 **Agent mode** - inspect, search, and edit files through a bounded tool loop
- ⚙️ **Configurable** - TOML config file + environment variable overrides
- 🔑 **Simple auth** - just set `OPENAI_API_KEY` and go
- 🔌 **Two API protocols** - native Gemini and OpenAI-compatible `/chat/completions`
- 🧵 **Restorable sessions** - conversations are saved and grouped by working directory

## Quick Start

### Prerequisites

- [Rust](https://rustup.rs/) (1.85+)
- An API key for OpenAI or an OpenAI-compatible service (not needed for local
  servers that do not require authentication)
- Linux `bubblewrap` (`bwrap`) for the default shell tool (or use `--no-shell`)

### Build & Run

```bash
# Build
cargo build --release

# Set your API key
export OPENAI_API_KEY="your-api-key-here"

# Run interactive mode
./target/release/maicli

# Or single prompt mode
./target/release/maicli -p "Explain Rust ownership in 3 sentences"

# Run an agent task against the current workspace
./target/release/maicli --agent -p "Inspect the project and update its README"
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
maicli
```

Opens a full TUI chat interface. Type messages and press Enter to send.

### Single Prompt

```
maicli -p "What is the Rust borrow checker?"
```

### Agent Mode

Agent mode gives the model a reusable tool loop for the current working
directory:

```bash
# File inspection, search, and workspace edits
maicli --agent -p "Find duplicated error handling and refactor it"

# Build and test commands are enabled by default in the sandbox
maicli --agent -p "Fix the failing tests and verify the result"

# Limit the number of model/tool turns
maicli --agent --agent-max-steps 6 -p "Summarize this project"
```

The default tools are `list_files`, `read_file`, `search_files`, `write_file`,
and `replace_in_file`. File paths are restricted to the current workspace;
absolute paths, parent traversal, and symlink escapes are rejected.

Shell execution is enabled by default on Linux and requires `bubblewrap` on
`PATH`. Use `--no-shell` to remove `run_command` from the available tools;
`--allow-shell` remains available as an explicit compatibility flag. Commands
run inside an OS-enforced sandbox with:

- a read-only host root and writable access only to the current workspace and
  an ephemeral `/tmp`;
- `.git`, `.agents`, and `.codex` below the workspace remounted read-only;
- a separate PID, IPC, UTS, user, and cgroup namespace; the host network is
  inherited so package managers, browsers, and other approved commands can
  access the internet;
- a cleared environment with only a small non-secret allowlist;
- a seccomp filter that rejects privilege, mount, tracing, kernel-module,
  keyring, BPF, and namespace-escape system calls.

If bubblewrap, user namespaces, or seccomp setup is unavailable, execution
fails closed; it never falls back to the host shell. Command sandboxing is
currently unavailable on non-Linux platforms.

In interactive mode, start with `maicli --agent` or switch at runtime with
`/agent on` and `/agent off`. Tool results are shown separately from the model
conversation.

When the provider returns reasoning, it appears in a separate `Thinking` block
while streaming and collapses automatically when the answer or tool action is
ready. Click the `Thinking` heading, press `F4`, or use `/thinking` to expand or
collapse the latest block. OpenAI-compatible responses support
`reasoning_content` and `reasoning`; native Gemini responses support parts with
`thought: true`. Models or servers that do not expose reasoning continue to
show only the final answer.

The input border has two clickable segmented controls in its upper-right
corner:

- `Chat / Agent` switches the conversation mode.
- `Auto / Safe / Manual` controls tool approval. Auto is the default and runs
  every requested tool without an approval prompt. Safe applies deterministic
  command rules: narrow read/build commands run directly, forbidden commands
  are rejected, and commands requiring review are sent to a separate model
  approval review. Manual pauses before every non-forbidden tool call and
  replaces the mode controls with clickable `Approve / Reject` actions.

The command rule engine safely splits only plain command chains joined by
`&&`, `||`, `;`, or `|` and applies the most restrictive result in Safe and
Manual modes. Shell
expansion, redirection, assignments, globs, control flow, and nested shells are
treated conservatively and require review. Automatic review uses an additional
model call, enforces a low/medium/high/critical risk threshold, requires
explicit user authorization for high-risk actions, denies critical risk, and
fails closed on API, timeout, or parse errors when Safe mode invokes it.
Approval is not a replacement
for the sandbox: every approved command still executes inside the same fixed
boundary.

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
| `--allow-shell` | Explicitly enable sandboxed shell commands (the default) |
| `--no-shell` | Disable the Agent shell command tool |
| `-d, --debug` | Enable debug logging |

### Slash Commands (Interactive Mode)

| Command | Description |
|---------|-------------|
| `/help`, `/h` | Show available commands |
| `/clear`, `/c` | Clear history and start a new HTTP session |
| `/sessions`, `/session`, `/s` | Open the session restore picker for this directory |
| `/model <name>`, `/m` | Switch model |
| `/agent on\|off`, `/a on\|off` | Switch between Agent and chat modes |
| `/approval auto\|safe\|manual` | Set Agent tool approval behavior |
| `/tools` | Show the currently enabled Agent tools |
| `/thinking`, `/think` | Expand/collapse the latest thinking block |
| `/config` | Show current configuration |
| `/quit`, `/q` | Exit |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `F2` | Switch between Chat and Agent |
| `F3` | Cycle Auto, Safe, and Manual approval |
| `F4` | Expand/collapse the latest thinking block |
| `Enter` / `Y` | Approve a pending Manual tool call |
| `Esc` / `N` | Reject a pending Manual tool call |
| `Ctrl+C` | Cancel stream / Quit |
| `Ctrl+D` | Quit |
| `Ctrl+U` | Clear input |
| `Ctrl+A` | Move cursor to start |
| `Ctrl+E` | Move cursor to end |
| `PageUp/Down` | Scroll messages |

The mouse can click all input-border controls and use the wheel to scroll the
conversation. Completed `Thinking` headings are also clickable.

## Sessions and restore

Interactive conversations are saved automatically. maicli maintains an
internal mapping from the canonical working-directory path to its sessions, so
starting the TUI in a directory with saved conversations opens a restore
picker. Use the arrow keys (or `j`/`k`) and `Enter` to restore a conversation,
or choose **Start a new session**. `n` and `Esc` also start a new session. The
same picker can be reopened at any time with `/sessions`.

The session store lives below the platform's local application-data directory
(on Linux, normally `$XDG_DATA_HOME/maicli/sessions` or
`~/.local/share/maicli/sessions`). `index.json` holds the directory-to-session
mapping and `records/` contains the conversation records. Restoring brings back
both the visible conversation/API context and its UUID-style `session-id`.

Every Gemini or OpenAI-compatible HTTP request, including all Agent model
turns, sends that ID in the `session-id` header. `/clear` preserves the old
record, clears the active history, and rotates the identifier so the next
message starts a new session. `/config` displays the current identifier for
diagnostics.

## Configuration

Config file location: `~/.config/maicli/config.toml`

On first launch after upgrading, maicli copies an existing
`~/.config/gemini-cli/config.toml` to the new location. An existing maicli
configuration is never overwritten.

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
  maicli --provider openai --model gpt-4o-mini -p "Hello"
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
