# Mai GUI — Tauri shell for the Gemini-backed coding agent

The desktop-app twin of `../cli`'s Ink terminal UI. This project
owns exactly one thing the CLI doesn't need: a window and process
orchestration. **All agent logic lives in `apps/cli` and is reused
unchanged** — this app spawns `apps/cli/dist/daemon.js` as a
subprocess and talks to it over newline-delimited JSON on stdin/stdout, then
relays those messages to a React frontend over Tauri's event system.

```
┌─────────────────────────┐        stdio (JSON lines)       ┌──────────────────────────┐
│ React frontend (webview)│ ───invoke()──▶ Rust (src-tauri) │ ──▶ Node daemon           │
│ src/App.tsx              │ ◀──emit()──                     │     apps/cli/      │
└─────────────────────────┘                                  │     dist/daemon.js        │
                                                               │  (same GeminiClient,      │
                                                               │   ToolRegistry, approval  │
                                                               │   engine, sandbox sidecar │
                                                               │   the CLI uses)           │
                                                               └──────────────────────────┘
```

## Setup

```bash
npm install
```

Requires `apps/cli` to be built (`npm run build -w mai-cli` from the repository root)
— that's where the daemon this app spawns lives. On Linux, also needs the
WebKitGTK dev headers to compile:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev librsvg2-dev patchelf
```

## Run it

```bash
npm run tauri dev      # hot-reloading dev build
npm run tauri build -- --no-bundle   # raw binary is written under the root target directory
```

## Desktop service and installers

Mai stays resident in the system tray, can register itself to start at login,
and supervises both the stdio agent daemon and the local HTTP API. The API
sidecar is restarted if it exits unexpectedly. Closing the window hides it;
use **Quit Mai** in the tray menu to terminate Mai and its children.

Build all native sidecars and the current platform's installer with one
command from the repository root:

```bash
npm run bundle
```

Release CI builds Linux, Windows, macOS Intel, and macOS Apple Silicon
installers. Full deployment, CI variable, Docker, security, and signing
instructions live in
[`../../docs/deployment.md`](../../docs/deployment.md).

## Switching between CLI and GUI

- **CLI → GUI**: type `/gui` in the Ink CLI. It writes the current
  conversation to a handoff file (`$TMPDIR/mai-handoff-<workspace-hash>.json`,
  written by `apps/cli/src/handoff.ts`), spawns this app, and exits.
- **GUI → CLI**: click "Open in CLI". The Rust `switch_to_cli` command asks
  the daemon to write the same handoff file (it already holds the
  model-side conversation state), waits for confirmation, opens a terminal
  emulator running the CLI in the same workspace (tries gnome-terminal,
  konsole, xfce4-terminal, alacritty, kitty, x-terminal-emulator, xterm, in
  that order on Linux; Terminal.app via `osascript` on macOS; Windows
  Terminal or `cmd` on Windows), then the frontend closes the window.

Either side reads and deletes the handoff file on startup, so it's a
one-shot resume, not a synced/shared session.

## Layout

- `src-tauri/src/lib.rs` — spawns the daemon, relays its stdout as
  `daemon-event`/`daemon-fatal` Tauri events, exposes `send_message` /
  `approve` / `clear_conversation` / `interrupt_turn` / `switch_to_cli` /
  `get_ready_info` commands. `get_ready_info` exists because the daemon can
  finish starting (and emit `ready`) before the frontend's event listener
  is registered — Tauri doesn't buffer events for late subscribers — so the
  frontend also pulls the cached payload directly on mount as a fallback.
- `src/shared.ts` — frontend reducer state plus wire types imported from
  the shared `packages/protocol` workspace package.
- `src/App.tsx` — the chat UI: message list, composer, approval bar.

## Remaining platform work

- Terminal-launch candidates are only empirically verified on Linux
  (gnome-terminal). The macOS/Windows branches compile but are unverified.
- macOS and Windows do not yet have a native equivalent of the Linux
  bubblewrap/seccomp shell sandbox, so shell calls fail closed there.
- Icons are still the `create-tauri-app` placeholders and should be replaced
  before a public signed release.
