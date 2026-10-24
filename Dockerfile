# syntax=docker/dockerfile:1.7

FROM rust:1.93-bookworm AS sandbox-builder
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/mai-rust ./crates/mai-rust
COPY apps/desktop/src-tauri/Cargo.toml ./apps/desktop/src-tauri/Cargo.toml
COPY apps/desktop/src-tauri/src ./apps/desktop/src-tauri/src
COPY apps/desktop/src-tauri/build.rs ./apps/desktop/src-tauri/build.rs
RUN cargo build --manifest-path crates/mai-rust/Cargo.toml --release --locked --bin mai-sandbox

FROM node:24-bookworm-slim AS app-builder
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
RUN npm ci
COPY packages/protocol ./packages/protocol
COPY apps/cli ./apps/cli
RUN npm run build -w @mai/protocol \
    && npm run build -w mai-cli \
    && npm prune --omit=dev

FROM rust:1.93-bookworm AS runtime
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash mai

WORKDIR /app
COPY --from=app-builder /src/node_modules ./node_modules
COPY --from=app-builder /src/apps/cli/dist ./apps/cli/dist
COPY --from=app-builder /src/apps/cli/package.json ./apps/cli/package.json
COPY --from=app-builder /src/apps/cli/providers.json ./apps/cli/providers.json
COPY --from=sandbox-builder /src/target/release/mai-sandbox /usr/local/bin/mai-sandbox

ENV NODE_ENV=production \
    MAI_SANDBOX_BIN=/usr/local/bin/mai-sandbox \
    MAI_SANDBOX_PROC_MODE=bind \
    MAI_ALLOW_SHELL=true \
    MAI_API_HOST=0.0.0.0 \
    MAI_API_PORT=3141 \
    MAI_API_ALLOW_WRITE=true \
    MAI_API_ALLOW_SHELL=true \
    MAI_API_APPROVAL_MODE=auto

USER mai
WORKDIR /workspace
EXPOSE 3141
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3141/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "/app/apps/cli/dist/api-main.js"]
