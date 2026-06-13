# cortexmd MCP server — multi-stage container build.
#
# Build context is the repo root; the server lives in packages/server. Native
# deps (better-sqlite3, @huggingface/transformers, hnswlib-node, tree-sitter*)
# compile from source, so the builder stage carries python3 + make + g++.
#
#   docker build -t cortexmd .
#   docker run --rm -p 3000:3000 -v cortexmd-data:/app/data cortexmd
#
# No secrets are baked in: API_KEY / DASHBOARD_PASSWORD are read from the
# environment at runtime and auto-generated (and persisted under DATA_DIR) when
# unset. See docker-compose.yml for an env-driven deployment.

# --- Stage 1: build ---------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# Toolchain for native addon compilation.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first (better layer caching). The server is a workspace package,
# so its lockfile + manifest are self-contained under packages/server.
COPY packages/server/package*.json ./
RUN npm ci

# Build the TypeScript server.
COPY packages/server/tsconfig.json ./
COPY packages/server/src ./src
RUN npm run build

# --- Stage 2: runtime -------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=3000 \
    DATA_DIR=/app/data

# Release version + commit, injected at build time by CI (release.yml). Default
# to "dev"/"unknown" for local builds. Surfaced via /health and the MCP server
# identity so the deployed build is verifiable without shelling into the box.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION \
    GIT_SHA=$GIT_SHA

# Production deps need the toolchain to rebuild native addons, then it is
# purged to keep the runtime image small. git stays for git-backed source
# vaults (git+https:// transport); see docs/transports.md.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*
COPY packages/server/package*.json ./
RUN npm ci --omit=dev \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist

# Writable data dir (SQLite cache, HNSW index, model cache, source-cache/).
# node:* images ship a non-root `node` user (uid/gid 1000).
RUN mkdir -p /app/data/embeddings /app/data/models \
  && chown -R node:node /app/data
USER node

EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=10s --retries=3 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
