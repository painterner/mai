# OpenAI authentication and Responses API

Mai uses one OpenAI-compatible client for both Chat Completions and Responses.
Provider identity, wire protocol, authentication, and hosted capabilities are
configured independently; a third-party service that implements Responses does
not require another client class.

## OpenAI provider

```json
{
  "name": "openai",
  "kind": "openai",
  "type": "openai",
  "wireApi": "responses",
  "baseUrl": "https://api.openai.com/v1",
  "auth": {
    "type": "codex-login",
    "chatgptBaseUrl": "https://chatgpt.com/backend-api/codex"
  },
  "capabilities": {
    "webSearch": true,
    "reasoning": true,
    "imageGeneration": false
  },
  "model": "gpt-6-sol"
}
```

`type` identifies vendor-specific behavior. `wireApi` selects request and SSE
encoding. `auth` selects the credential manager. `capabilities` controls tools
that Mai is allowed to advertise; they are never inferred solely from a model
name or compatible base URL.

Legacy entries containing only `kind`, `apiKeyEnv`, `baseUrl`, and `model`
continue to use Chat Completions unchanged.

## Login methods

Inside `mai`:

```text
/login                 Show all methods
/login status          Inspect the current file-backed login
/login browser         ChatGPT browser callback flow
/login device          Headless-friendly device-code flow
/login api-key         Read OPENAI_API_KEY from the process environment
/login access-token    Read CODEX_ACCESS_TOKEN from the process environment
/login reuse           Refresh and reuse an existing Codex login
/logout                Remove the file-backed login
```

The desktop OpenAI panel sends the same operations through the shared daemon.
Secrets are deliberately not accepted as slash-command arguments or GUI form
values. This keeps them out of shell history, the Mai transcript, daemon JSON,
and HTTP API state.

Mai invokes the installed `codex` executable for login. Override it with
`MAI_CODEX_BIN=/absolute/path/to/codex`. `CODEX_HOME` selects the credential
directory and defaults to `~/.codex`. Mai forces file-backed storage for login
operations so its token manager can work consistently across Linux, macOS, and
Windows.

Codex CLI login tokens and Sign in with ChatGPT direct-use tokens are not
interchangeable. A reused Codex ChatGPT login is routed through the configured
Codex plan endpoint and carries `ChatGPT-Account-ID`; an API key continues to
use the public `baseUrl`. Do not point arbitrary third-party credentials at the
ChatGPT endpoint.

For an expiring ChatGPT access token, Mai starts a short-lived local
`codex app-server`, calls `account/read` with `refreshToken: true`, stops the
process, then reads only the new access token. Refresh tokens and the complete
auth document are never returned to Node callers, the desktop renderer, or
Mai's external HTTP API.

If no file-backed login exists, `OPENAI_API_KEY` is accepted as a fallback and
uses the public `baseUrl` rather than `chatgptBaseUrl`.
This is the intended path for Docker and non-interactive CI images that do not
contain the Codex executable.

## Hosted web search

For an OpenAI Responses provider with `capabilities.webSearch: true`, every
request advertises:

```json
{
  "type": "web_search",
  "external_web_access": true
}
```

The shared event layer exposes search start/running/completed events and URL
citations to CLI, desktop, daemon, and HTTP API consumers. The system prompt
also prefers hosted search over a Brave/MCP search skill, while retaining the
external skill as a fallback when hosted search fails.

## Third-party Responses provider

```json
{
  "name": "responses-proxy",
  "kind": "openai",
  "type": "openai-compatible",
  "wireApi": "responses",
  "baseUrl": "https://gateway.example/v1",
  "auth": { "type": "env", "env": "RESPONSES_PROXY_KEY" },
  "capabilities": {
    "webSearch": false,
    "reasoning": false
  },
  "model": "provider-model"
}
```

Hosted OpenAI tools are not enabled merely because a service accepts the
Responses shape. Enable only capabilities the selected upstream actually
implements.

## Security boundary

Treat `CODEX_HOME/auth.json` like a password. Do not commit, print, upload, or
mount it into an untrusted container. A personal Codex/ChatGPT login is for the
local user who authenticated it; do not expose that identity through a public
or multi-user Mai API. Hosted deployments should use an operator API key or a
separate per-user OAuth/Sign in with ChatGPT flow.

## OpenAI references

- [Codex app-server login methods](https://learn.chatgpt.com/docs/app-server)
- [Sign in with ChatGPT token sharing](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Codex model catalogs](https://learn.chatgpt.com/docs/model-catalogs)
- [Responses API migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
