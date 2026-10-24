# Mai monorepo guide

- `apps/cli` owns the Node agent runtime, Ink CLI, daemon, HTTP API and protocol source of truth.
- `apps/desktop` is the React/Tauri host and must not fork agent behavior.
- `crates/mai-rust` owns the Rust TUI and `mai-sandbox` sidecar.
- Run `npm run check` before completing cross-component changes.
- Keep public provider examples free of private endpoints and credentials; use `providers.local.json` locally.
