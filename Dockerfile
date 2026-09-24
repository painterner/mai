# syntax=docker/dockerfile:1.7

FROM rust:1.93-bookworm AS sandbox-builder
WORKDIR /src/mail-cli-rust
COPY --from=sandbox-src . .
RUN cargo build --release --locked --bin mai-sandbox

FROM node:24-bookworm-slim AS app-builder
WORKDIR /src/mai-cli-node
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json providers.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Keep both Node and Rust toolchains available to run normal build/test
# workflows inside the agent sandbox. The inner bubblewrap namespace still
# removes networking and makes everything except /workspace and /tmp read-only.
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
COPY --from=app-builder /src/mai-cli-node/dist ./dist
COPY --from=app-builder /src/mai-cli-node/node_modules ./node_modules
COPY --from=app-builder /src/mai-cli-node/package.json ./package.json
COPY --from=app-builder /src/mai-cli-node/providers.json ./providers.json
COPY --from=sandbox-builder /src/mail-cli-rust/target/release/mai-sandbox /usr/local/bin/mai-sandbox

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
CMD ["node", "/app/dist/api-main.js"]
