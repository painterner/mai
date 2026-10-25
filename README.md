# Mai

Mai is a local coding agent with a terminal UI, desktop application, persistent
HTTP Agent API, skills and MCP support, and a Rust sandbox sidecar.

## Repository layout

```text
apps/cli/             Node.js agent core, terminal UI, daemon and HTTP API
apps/desktop/         React + Tauri desktop application
crates/mai-rust/      Rust TUI and mai-sandbox sidecar
docs/                 API and deployment documentation
```

The Node agent is the shared runtime used by the terminal UI, desktop daemon,
and HTTP API. The desktop app owns presentation and lifecycle only. Shell
commands execute through the `mai-sandbox` binary built from `crates/mai-rust`.

## Development

Requirements:

- Node.js 22.5 or newer
- Rust stable
- Linux `bubblewrap` for the full sandbox
- Tauri system dependencies when building the desktop installer

```bash
npm install
npm run build
npm test
npm run cargo:test
npm run cargo:check
```

Run the terminal UI:

```bash
npm run dev -w mai-cli
```

The built-in OpenAI provider uses the Responses API, supports hosted web
search, and can reuse a local Codex/ChatGPT login. Run `/login` in the CLI or
use the OpenAI button in the desktop toolbar. See
[OpenAI authentication and Responses](docs/openai-auth.md).

Run the API:

```bash
npm run api:dev -w mai-cli
```

Run the desktop application:

```bash
npm run tauri -w mai-gui dev
```

User-wide provider settings belong in `~/.mai/providers.json`. Mai merges that
file by provider name over the defaults in `apps/cli/providers.json`, then
applies workspace `providers.json` and `providers.local.json` overrides. The
local filename is ignored by Git. Public examples live in
`apps/cli/providers.json` and `providers.example.json`.

See [API documentation](docs/api.md), [deployment documentation](docs/deployment.md),
and [contribution guidelines](CONTRIBUTING.md).

## Releases

One `v*` tag represents one Mai product release. CI builds the CLI and API,
Rust components, desktop installers, and the container image from the same
commit.

## License

MIT — see [LICENSE](LICENSE).
