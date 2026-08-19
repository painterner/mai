# Mai — a coding agent (Ink terminal UI)

An Ink (React-for-terminals) CLI agent, in the same family as Gemini CLI /
Codex CLI / Claude Code's terminal front-ends. It talks to **Gemini or any
OpenAI-compatible API** (`API_PROVIDER=gemini|openai` — see below) with
native function calling, can read/search/write files in the current
workspace, and runs shell commands through a **Rust sidecar** that sandboxes
them (bubblewrap + a hand-built seccomp filter — see
[`../mail-cli-rust`](../mail-cli-rust)). Risky or destructive actions
pause for interactive approval before they run.

## Setup

```bash
npm install
cp .env.example .env   # then fill in GEMINI_API_KEY (or set API_PROVIDER=openai + OPENAI_API_KEY)
```

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
   `sudo`).
3. `run_command` calls are handed to the `mai-sandbox` sidecar
   (`src/sandbox/sidecar.ts`): one JSON request over stdin, one JSON
   response over stdout. All the OS-level sandboxing (bubblewrap
   namespaces, the seccomp-BPF filter, `memfd_create`) lives in that Rust
   binary — see the project conversation for why that part specifically
   doesn't belong in JS.
4. Results feed back to the model as `functionResponse` parts and the loop
   repeats until the model stops calling tools.

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

- `src/config.ts` — loads `.env`, resolves `API_PROVIDER` + the matching
  `{GEMINI,OPENAI}_*` vars into one provider-agnostic `Config`, resolves
  the sandbox binary path.
- `src/llm/types.ts` — the provider-agnostic `Content`/`Part` conversation
  model and `LlmClient` interface both clients implement.
- `src/llm/gemini.ts` / `src/llm/openai.ts` — the two `LlmClient`s (SSE
  parsing, native function/tool calling), no SDK dependency — wire formats
  confirmed against Google's/OpenAI's docs and the sibling Rust client.
  `src/llm/index.ts` has the `createLlmClient(config)` factory.
- `src/agent/tools.ts` — `list_files` / `read_file` / `search_files` /
  `write_file` / `replace_in_file` / `run_command`, with workspace-escape
  protection (rejects `..`, absolute paths, and symlink escapes via
  `realpath`).
- `src/agent/approval.ts` — the risk-classification rule engine (ported
  from Rust, including its small shell-script tokenizer).
- `src/agent/loop.ts` — orchestrates model turns, tool execution, and the
  approval gate; yields UI-facing events.
- `src/sandbox/sidecar.ts` — talks JSON-over-stdio to `mai-sandbox`.
- `src/agent/reducer.ts` — turns an `AgentEvent` stream into the `Message[]`
  transcript a UI renders; shared by `App.tsx` and (a duplicated copy of)
  the GUI's frontend so both render turns identically.
- `src/daemon.ts` + `src/handoff.ts` — the headless JSON-stdio agent daemon
  the GUI spawns, and the `/gui`⇄"Open in CLI" session handoff file format.
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
