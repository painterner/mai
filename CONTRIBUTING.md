# Contributing

## Setup

```bash
npm install
npm run build
npm test
npm run cargo:test
npm run cargo:check
```

Keep changes scoped, add tests for behavior changes, and update documentation
when a command, protocol, configuration key, or deployment path changes.

Cross-component daemon protocol changes must update both `apps/cli` and
`apps/desktop` in the same pull request.

Do not commit `.env`, `providers.local.json`, API keys, private endpoints,
generated sidecars, `node_modules`, `dist`, or Cargo `target` directories.
