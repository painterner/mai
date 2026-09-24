# Mai — a coding agent (Ink terminal UI)

An Ink (React-for-terminals) CLI agent, in the same family as Gemini CLI /
Codex CLI / Claude Code's terminal front-ends. It talks to **any number of
providers declared in `providers.json`** — Gemini's native protocol or
anything OpenAI-compatible (real OpenAI, Groq, DeepSeek, OpenRouter, a local
vLLM/Ollama server, ...) — with native function calling, can inspect readable
system paths while keeping file writes inside the current workspace, and runs
shell commands through a **Rust
sidecar** that sandboxes them (bubblewrap + a hand-built seccomp filter —
see [`../mail-cli-rust`](../mail-cli-rust)). Tool approval defaults to `auto`,
which runs tool calls without prompts; `/approval safe` enables risk-based
approval and `/approval manual` asks before every non-forbidden tool. Sandboxed commands inherit
the execution node's network, so `curl`, Git, and package-manager
operations can access the internet.

## Setup

```bash
npm install
cp .env.example .env   # then fill in GEMINI_API_KEY (or set API_PROVIDER=openai + OPENAI_API_KEY)
```

### Providers

`providers.json` (in this directory) is the list of providers Mai can talk
to — each entry has a `name`, a wire `kind` (`"gemini"` or `"openai"`-
compatible), a `baseUrl`, a default `model`, and an `apiKeyEnv` naming which
`.env` var holds its key. Ships with `gemini` + `openai`; see
`providers.example.json` for more (Groq, DeepSeek, OpenRouter, a local
Ollama server). To add a provider: append an entry and set its `apiKeyEnv`
var in `.env`. `API_PROVIDER` picks which entry is active at startup by
`name`; `/model` in the running CLI (or the **Model** button in the GUI)
opens the interactive provider/model picker. `/model <model>` directly
selects a model from the current provider, while `/model <model> <provider>`
selects both, for example `/model gpt-5.6-sol openai`. Switching never needs
a restart: Mai validates names against the provider's live model-discovery
route and persists the selection in the workspace.

A workspace can drop its own `providers.json` next to its `.env` to pin a
different list — same "follows the workspace" convention as `.env` itself;
Mai falls back to the copy shipped in this project if the workspace has
none.

The `run_command` tool needs the sandbox sidecar built once, from the sibling
Rust repo:

```bash
cd ../mail-cli-rust
cargo build --release --bin mai-sandbox
```

Mai looks for that binary at `../mail-cli-rust/target/{release,debug}/mai-sandbox`
relative to this project automatically. If your layout differs, set
`MAI_SANDBOX_BIN=/path/to/mai-sandbox` in `.env`. Without it, every other
tool (file read/write/search) still works — only `run_command` is affected,
and it fails with a clear message rather than silently running unsandboxed.

Sandboxing currently requires Linux + bubblewrap (same constraint as the
Rust CLI). Set `MAI_ALLOW_SHELL=false` to drop the `run_command` tool
entirely on platforms where it isn't available.

## Run it

```bash
npm run dev     # tsx, no build step
# or
npm run build && npm start
```

The input stays active while Mai is responding. Normal submissions are queued
as later model turns. Press `Ctrl+X` to switch the composer between Prompt and
Shell mode; Shell submissions run immediately through `mai-sandbox`, in order,
without waiting for the active model turn. Press `Ctrl+X` again (or `Esc`) to
return to Prompt mode. From Prompt mode, `!command` runs one shell command
without switching modes. Completed command output is displayed in the
transcript and supplied as context to the next model turn.

## HTTP API

Mai also has a persistent Agent Gateway backed by the same provider clients,
agent loop, skills, workspace tools, approval rules, and Rust sandbox as the
CLI and GUI:

```bash
npm run api:dev               # development
# or
npm run build && npm run api  # compiled
```

It listens on `127.0.0.1:3141` by default. The primary API provides durable
sessions and asynchronous runs, resumable SSE events, remote approvals,
steering/cancellation, skills/tools discovery, direct workspace files, and
interactive sandbox PTYs. State is stored in `.mai/api.sqlite`; the old
stateless `POST /v1/chat` remains compatible. API file writes and shell execution
are disabled by default; approval mode defaults to `auto`. See
[`docs/api.md`](docs/api.md) for request/response formats, authentication,
configuration, streaming events, conversation history, and security notes.

For distribution, Mai ships as a Tauri desktop host (tray + autostart +
packaged sidecars) and as a full-featured Docker service. The Docker profile
keeps workspace writes and the bubblewrap/seccomp shell enabled. See
[`docs/deployment.md`](docs/deployment.md) for Compose, local installers,
cross-platform release CI, signing, and the platform support matrix.

## How a turn works

1. Your message + conversation history go to the active provider's
   streaming endpoint (`streamGenerateContent` for Gemini,
   `/chat/completions` with `stream: true` for OpenAI-compatible) with the
   workspace tools declared as native function/tool calls — not the
   prompt-hacked "reply with one JSON object" protocol the Rust CLI uses —
   so you get real token-level streaming of the final answer. Both
   providers are implemented against one internal `LlmClient` interface
   (`src/llm/types.ts`); `agent/loop.ts` and everything above it doesn't
   know or care which one is active. The trickiest part of the OpenAI side:
   streamed tool-call *arguments* arrive as raw string fragments keyed by
   index and have to be concatenated before they're valid JSON — Gemini
   hands you the whole `functionCall` args object in one piece.
2. Each function call the model requests is classified by a **risk rule
   engine** ported line-for-line from `mail-cli-rust`'s
   `agent/approval.rs` (`src/agent/approval.ts`): auto-allow, pause for
   review, or forbid outright (e.g. `rm -rf /`, touching `.ssh`/`.env`,
   `sudo`). `safe` follows that classification, `manual` asks for each
   non-forbidden call, and the default `auto` bypasses approval classification.
   All modes still execute through the configured tool and sandbox boundaries.
3. `run_command` calls are handed to the `mai-sandbox` sidecar
   (`src/sandbox/sidecar.ts`): one JSON request over stdin, one JSON
   response over stdout. All the OS-level sandboxing (bubblewrap
   namespaces, the seccomp-BPF filter, `memfd_create`) lives in that Rust
   binary — see the project conversation for why that part specifically
   doesn't belong in JS.
4. Results feed back to the model as `functionResponse` parts and the loop
   repeats until the model stops calling tools.

## Skills

Mai discovers [Agent Skills](https://code.claude.com/docs/en/skills) —
`SKILL.md` packages of task-specific instructions — from `~/.agents/skills`
(personal, cross-project) and `<workspace>/.agents/skills` (project-local),
merged by name with the workspace copy winning on a collision. Nothing
extra to install: a skill written for Claude Code or Codex works here
unmodified, same file format. `/skills` lists what was found. A skill can be
invoked directly as `/<name> [args]` (for example `/astro-setup my-app`) or
with `/skills <name> [args]`; both forms are included in Tab completion and
work for manual-only skills too. A one-line `name: description` catalog goes
into the system prompt for every skill
*not* marked `disable-model-invocation: true` in its frontmatter, and the
model calls the `load_skill` tool with a skill's name to pull its full
instructions into context on demand — skills aren't dumped into the system
prompt wholesale, so having many (or large) ones installed doesn't bloat
every request. `src/agent/skills.ts` has the discovery/parsing; it's a
deliberately minimal YAML-subset parser (flat scalars, quoted strings,
`>`/`|` block scalars) rather than a real YAML dependency, sized to what
`SKILL.md` frontmatter actually uses.

## MCP tools

Mai is an MCP stdio client. A self-contained Skill can declare an MCP tool
dependency in `agents/openai.yaml` and provide `scripts/serve.sh`; Mai starts
that local server, performs MCP initialization and `tools/list`, exposes its
tools to the root model, and closes it with the CLI/GUI/API process. This is
how the `brave-search` Skill keeps its API token inside its own server while
exposing only `web_search` to the model. A failed MCP server is isolated and
reported without preventing Mai from starting.

Standalone servers can be configured globally in `~/.agents/mcp.json` or
per workspace in `<workspace>/.agents/mcp.json` (workspace entries override
same-named global entries):

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["/absolute/path/server.mjs"],
      "cwd": "${HOME}/projects/example",
      "env": { "EXAMPLE_TOKEN": "${EXAMPLE_TOKEN}" }
    }
  }
}
```

Environment placeholders are resolved by the Mai host and are never added
to model prompts or tool descriptions. MCP tool risk metadata participates in
`safe` and `manual` approval behavior; `auto` executes MCP tools without
prompting. Built-in tool names win collisions, with the MCP tool exposed
as `<server>__<tool>` instead.

## Switching to the GUI

Type `/gui` to hand this conversation off to [`../mai-cli-gui`](../mai-cli-gui)
(a Tauri + React desktop app) and exit — it writes the conversation to a
handoff file, spawns the GUI binary, and the GUI resumes where you left off.
Needs the GUI built once (`cd ../mai-cli-gui && npm run tauri build -- --no-bundle`);
if it isn't, `/gui` says so instead of failing silently. `src/daemon.ts` is
the headless counterpart the GUI actually drives — same agent code as this
Ink UI, spoken over newline-delimited JSON on stdin/stdout instead of a
terminal.

## What's here

- `src/config.ts` — loads `.env` and `providers.json`, resolves
  `API_PROVIDER` against it (plus each entry's `{NAME}_MODEL`/
  `{NAME}_BASE_URL` overrides) into one provider-agnostic `Config`, resolves
  the sandbox binary path.
- `src/llm/types.ts` — the provider-agnostic `Content`/`Part` conversation
  model and `LlmClient` interface both clients implement.
- `src/llm/gemini.ts` / `src/llm/openai.ts` — the two `LlmClient`s (SSE
  parsing, native function/tool calling), no SDK dependency — wire formats
  confirmed against Google's/OpenAI's docs and the sibling Rust client.
  `src/llm/index.ts` has the `createLlmClient(config)` factory.
- `src/agent/tools.ts` — `list_files` / `read_file` / `search_files` accept
  readable absolute paths for system diagnosis while blocking known
  credential locations. `write_file` / `replace_in_file` stay confined to
  the workspace, but accept absolute paths that resolve inside it; symlink
  escapes are still rejected via `realpath`.
- `src/agent/approval.ts` — the risk-classification rule engine (ported
  from Rust, including its small shell-script tokenizer).
- `src/agent/skills.ts` — discovers and parses `SKILL.md` files from
  `~/.agents/skills` + `<workspace>/.agents/skills`; see "Skills" above.
- `src/agent/mcp.ts` — discovers, starts, registers, calls, and closes stdio
  MCP servers; see "MCP tools" above.
- `src/agent/loop.ts` — orchestrates model turns, tool execution, and the
  approval gate; yields UI-facing events.
- `src/sandbox/sidecar.ts` — talks JSON-over-stdio to `mai-sandbox`.
- `src/agent/reducer.ts` — turns an `AgentEvent` stream into the `Message[]`
  transcript a UI renders; shared by `App.tsx` and (a duplicated copy of)
  the GUI's frontend so both render turns identically.
- `src/daemon.ts` + `src/handoff.ts` — the headless JSON-stdio agent daemon
  the GUI spawns, and the `/gui`⇄"Open in CLI" session handoff file format.
- `src/api.ts` + `src/api/` — the persistent HTTP Agent Gateway: sessions,
  runs, resumable events, approvals, files, capabilities, and interactive
  sandbox terminals while reusing the same agent code.
- `src/App.tsx` — wires all of the above into the UI: streaming
  text/thought bubbles, live tool-call cards, an `ApprovalPrompt` that
  replaces the input box while a risky call waits on you, Esc to abort a
  turn mid-flight (aborts the actual network request), Ctrl+C twice to
  exit.
- `src/components/ConversationView.tsx` — finished turns are handed to
  Ink's `<Static>` so they're painted once and never re-rendered; only the
  in-flight turn re-renders live.
- `src/components/InputPrompt.tsx` — a hand-rolled text field (no
  `ink-text-input`) with cursor movement, kill/word shortcuts (`Ctrl+U`,
  `Ctrl+W`, `Ctrl+A/E`), submitted-input history via ↑/↓, and a `/`
  slash-command dropdown.

## Not done yet

- `/theme` is still a placeholder — one dark theme only.
- Input history doesn't persist across runs.
- The OpenAI-side "thinking" support (`delta.reasoning_content`/`reasoning`,
  for servers like DeepSeek-R1 that add it) is implemented but not tested
  against a real reasoning-model deployment.
