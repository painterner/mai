# CLAUDE.md

Working notes for agents in this repo. `README.md` covers what the project
is and how a turn works — read it first. This file is only the things that
have actually bitten someone: cross-repo wiring, non-obvious constraints,
and how to verify a change without a TTY.

## One monorepo, three runtimes

| Directory | What it is | Git? |
|---|---|---|
| `apps/cli` (here) | Ink/React terminal UI **and** `src/daemon.ts`, the headless agent both front-ends run on |
| `apps/desktop` | Tauri + React desktop shell. Owns **no** agent logic — spawns this app's `dist/daemon.js` and relays JSON |
| `crates/mai-rust` | Rust TUI agent (`maicli`) and the `mai-sandbox` sidecar |

Two consequences worth internalizing:

- **The GUI has no agent code.** A feature that belongs to the agent goes in
  `src/daemon.ts` here, and the GUI gets a thin passthrough. Adding a
  daemon feature usually means touching *four* places: `daemon.ts` (protocol
  + handler), `apps/desktop/src-tauri/src/lib.rs` (`#[tauri::command]` +
  register it in `generate_handler!`), `apps/desktop/src/shared.ts` (event
  type), `apps/desktop/src/App.tsx` (UI). Miss the `generate_handler!` list
  and the invoke fails only at runtime.
- **`crates/mai-rust/src/agent/tools.rs` is not used by this repo.** That's
  `maicli`'s own tool registry. This repo re-implements the same tools in
  TypeScript (`src/agent/tools.ts`) and only shells out to the separate
  `src/bin/mai-sandbox.rs` binary, for `run_command` alone.

Daemon wire types live in `packages/protocol`; update that package instead of
duplicating `AgentEvent` or `Message` between applications.

## Build / verify

`mai` is on PATH via `npm link` → symlink to `dist/index.js`. **`npm run
build` is all you need** for a code change to take effect globally; never
re-run `npm link`.

But: **a running `mai`/GUI session is a live process holding the old code.**
Every "it's still broken" report in this project's history so far has been a
stale process. Tell the user to fully exit and relaunch, and say so
explicitly rather than assuming they will.

```bash
npm run build                                    # this repo
npm run build -w mai-gui
cargo build --manifest-path ../../crates/mai-rust/Cargo.toml --release --bin mai-sandbox
```

If a Tauri build fails with a path from a directory that no longer exists,
its `target/` cache has stale absolute paths baked in — `cargo clean` in
`src-tauri/` and rebuild (~1.5 min).

### Testing without a terminal

Ink needs a real TTY, so `node dist/index.js` from a tool call dies with
"Raw mode is not supported". Two ways around it:

**Drive the daemon directly** (best for agent/provider/protocol work — same
code path, no UI):

```bash
cd /tmp/scratch-workspace
{ printf '{"type":"send","text":"..."}\n'; sleep 20; \
  printf '{"type":"approve","approved":true}\n'; sleep 15; } \
  | timeout 40 node /path/to/apps/cli/dist/daemon.js
```

Note the `sleep`s: closing stdin exits the daemon, so a bare pipe kills it
before any response arrives. Pipe the output through `python3 -c` to filter
the JSON-per-line into something readable.

**Fake a TTY with `script`** (for actual Ink rendering questions):

```bash
script -qc "timeout 3 node /path/to/dist/index.js" /tmp/out.raw
cat -v /tmp/out.raw   # ANSI escapes made visible
```

Also: `cd /tmp/foo && ... && rm -rf /tmp/foo` leaves the shell in a deleted
cwd and every later command errors. `cd` back out first.

## Landmines

**Ink allows exactly one `<Static>` per app.** Its reconciler keeps a single
`rootNode.staticNode` pointer; a second `<Static>` mounting anywhere
silently overwrites it and the first one never paints again. The startup
banner and the transcript therefore share the one in
`src/components/ConversationView.tsx`. Both must live there — putting the
header back in `App.tsx` as its own `<Static>` makes the banner vanish
entirely.

**`<Static>` is `position: absolute`, so it does *not* inherit the terminal
width.** With `width: auto` it shrink-wraps to its content's max-content
width and is never clamped to the screen, so one over-wide item (a long
`cwd` in the banner, a tool call with a long argument) makes the whole
static block render wider than the terminal. The emulator then hard-wraps
every line of it, shredding box borders — which reads as "the UI is
scrambled", and is worst on a narrow terminal. `ConversationView` pins
`style={{ width }}` to the real column count so Ink does the wrapping.

**A terminal resize needs a full manual redraw.** Ink paints `<Static>`
once, into the scrollback, and erases the live region by counting the
*newlines* in the last frame rather than the screen rows it occupies. A
resize (zooming counts) invalidates both: the transcript was laid out for
the old width, and the emulator has reflowed the live region into a
different row count than Ink is about to erase, so frames land on top of
each other. `App.tsx`'s `redraw()` is the fix — clear screen + scrollback,
then bump `redrawKey` to remount `<Static>` so it re-emits the whole
transcript at the new width. `/clear` uses the same path, since dropping
`history` alone leaves the old turns sitting in the scrollback.

**Ink's `exitOnCtrlC` (default true) swallows Ctrl+C before `useInput` sees
it** — a "press twice to confirm" handler silently never runs. `index.tsx`
renders with `exitOnCtrlC: false` and `App.tsx` owns Ctrl+C. It lives in
App, not `InputPrompt`, because the input row is swapped out wholesale
while an approval prompt or the model picker is up.

**Reasoning models want `reasoning_content` echoed back — session-wide.**
Some OpenAI-compatible providers (including DeepSeek-R1-style proxies)
style) 400 with *"The reasoning_content in the thinking mode must be passed
back to the API"* unless every assistant message in the replayed history
carries the field once *any* turn has produced reasoning — including turns
with no reasoning of their own, which need an empty string, not a missing
key. `toOpenAiMessages` tracks this with a `thinkingModeActive` flag. Real
OpenAI never streams `reasoning_content`/`reasoning` on Chat Completions, so
the flag never flips and its requests are byte-identical to before.

**Config layering** — three files, each with its own fallback rule:

- `providers.json` — the provider list. Workspace copy wins, else this
  repo's. Holds no secrets; committed.
- `.env` — secrets + global knobs (`MAI_*`, `API_PROVIDER`). Workspace
  first, then this repo's as a fallback for anything unset (dotenv never
  overwrites, so workspace wins). Lets `mai` run from any directory off one
  central `.env`. Gitignored.
- `.mai/state.json` — what `/model` last picked. **Workspace-only, no
  fallback** — "what I last chose here" is inherently per-project.
  Gitignored.

Startup precedence: `.mai/state.json` > `API_PROVIDER` > first
`providers.json` entry. A `{NAME}_MODEL`/`{NAME}_BASE_URL` env var overrides
that provider's `providers.json` defaults — easy to forget, and it silently
made a provider named `openai` point at a proxy once.

**Skills** are discovered from `~/.agents/skills` + `<workspace>/.agents/
skills`, but only the `name: description` catalog goes in the system prompt;
full bodies arrive via the model's `load_skill` tool call. `/skills <name>`
is the manual path — it bypasses `load_skill` entirely, so it works for
skills marked `disable-model-invocation: true`. Those skills' bodies often
say "only when the user invokes `/foo`", naming a slash command from
whatever tool they were written for; `App.tsx` prepends a note telling the
model `/skills <name>` satisfies that precondition.

## Naming history

Renamed twice: `gemini-cli-*` → `mai-cli-*`, and the product
name `Nova` → `Mai` (binaries `nova`→`mai`, `nova-sandbox`→`mai-sandbox`,
`nova-gui`→`mai-gui`; env vars `NOVA_*`→`MAI_*`; bundle id
`com.nova.gui`→`com.mai.gui`). Monorepo paths are resolved in `src/config.ts`
and `apps/desktop/src-tauri/src/lib.rs`. A lingering
`nova`/`gemini-cli` reference is usually rename fallout worth fixing — the
one deliberate exception is `LEGACY_CONFIG_DIR_NAME` in
`crates/mai-rust/src/config.rs`, which exists to keep reading old config
dirs. Leave it.
