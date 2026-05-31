# Deploy: self-hosted HTTP (advanced / team)

> The advanced path: an Express server over HTTP with authentication, for
> multi-client or remote setups. If you are a single user on one machine, you
> almost certainly want [`deploy-local.md`](./deploy-local.md) instead — it has
> no auth, no network, and no moving parts.

HTTP mode shares the entire core (search, memory, code-nav) with local-stdio;
only the **transport** (Express `/mcp` instead of stdio) and **auth** differ.
Source vaults are still read-only — but now they can arrive over a pluggable
transport (git pull / WebDAV / S3) instead of being on the local disk. See
[`transports.md`](./transports.md) and [`brain-vault.md`](./brain-vault.md).

## 1. Build & run

```sh
cd packages/server
npm ci
npm run build

BRAIN_VAULT=/data/brain \
SOURCE_VAULTS=/data/sources/notes \
API_KEY=$(openssl rand -hex 32) \
node dist/index.js          # listens on :3000 (API_PORT)
```

Binding a port (rather than passing `--stdio`) selects HTTP mode. The server
exposes MCP at `/mcp`.

### Docker

A multi-stage [`Dockerfile`](../Dockerfile) and an env-driven
[`docker-compose.yml`](../docker-compose.yml) live at the repo root. The image
builds the TS server (`packages/server`), compiles its native deps, and runs
`node dist/index.js` as a non-root user.

```sh
# Build standalone:
docker build -t cortexmd .
docker run --rm -p 3000:3000 \
  -v "$PWD/data/brain:/app/brain" \
  -v "$PWD/data/notes:/app/sources:ro" \
  -v cortexmd-data:/app/data \
  -e BRAIN_VAULT=/app/brain -e SOURCE_VAULTS=/app/sources \
  cortexmd
```

Compose is the easier path. Set host paths and options in a `.env` next to
`docker-compose.yml`, then bring it up:

```sh
cat > .env <<'EOF'
BRAIN_VAULT=./data/brain          # writable; the only dir the server writes
SOURCE_VAULTS=./data/notes        # read-only sources
API_PORT=3000
# API_KEY=                        # auto-generated + printed on first boot if unset
# DASHBOARD_PASSWORD=             # auto-generated + printed on first boot if unset
ENABLE_EMBEDDINGS=true
DREAM_SCHEDULE=                   # cron; empty disables consolidation
EOF

docker compose up -d --build
docker compose logs cortexmd      # grab the generated API key / password
```

No secrets are baked into the image. When `API_KEY` / `DASHBOARD_PASSWORD` are
unset, the server generates them once, persists them under `DATA_DIR`
(`/app/data`, a named volume), and prints them to the logs. The reranker and
forward-auth (`PROXY_AUTH`) are documented as **optional** in the compose file
and are off by default with no hardcoded host — see §2 and §5 below.

## 2. Authentication

Auth is required in HTTP mode — there is a network surface to protect. Three
layers, in increasing order of involvement; pick what fits.

### API key (simplest)

A single static Bearer token. Clients send `Authorization: Bearer <API_KEY>`.

```sh
API_KEY=$(openssl rand -hex 32)
```

Good for CI, a personal remote box, or a small trusted team.

### OAuth 2.0 (per-client identity)

The server ships a full OAuth 2.0 stack — RFC 8414 metadata discovery, RFC 7591
dynamic client registration, authorization-code + PKCE. Clients (including the
Rust CLI's `auth oauth-login`) bootstrap themselves with zero key paste:

```sh
cortexmd auth oauth-login --server https://mcp.example.com
```

`PUBLIC_URL` must be set to the externally reachable base URL so OAuth metadata
and callback links resolve correctly:

```sh
PUBLIC_URL=https://mcp.example.com
```

OAuth works **standalone** — you do not need an upstream identity provider.

### Forward-auth (optional)

If you already run an identity provider (Authelia, Traefik forward-auth, oauth2-proxy,
etc.) in front of the server, you can let it terminate auth on sensitive routes
and pass the result through. This is **entirely optional** — API key or
standalone OAuth are complete on their own. When used, set:

```sh
PROXY_AUTH=true     # trust the upstream proxy's forwarded auth headers
```

Only enable `PROXY_AUTH` when a trusted reverse proxy actually sits in front of
the server; otherwise clients could spoof the forwarded headers.

## 3. Reverse proxy & TLS

Terminate TLS at a reverse proxy and forward to the server's `API_PORT`
(default `3000`). Minimal nginx sketch:

```nginx
server {
  listen 443 ssl;
  server_name mcp.example.com;
  # ssl_certificate / ssl_certificate_key ...

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

Set `PUBLIC_URL=https://mcp.example.com` so OAuth metadata advertises the
external URL, not `localhost`.

## 4. Source vaults over a transport

In HTTP mode a source vault need not be on the server's local disk. Each
`SOURCE_VAULTS` entry's path may carry a transport scheme, selected
automatically by the registry:

| Scheme | Transport | `refresh()` |
|--------|-----------|-------------|
| (plain path) | `LocalVault` | no-op |
| `git+https://host/repo.git#branch` | `GitPullVault` | `git pull` on an interval |
| `webdav+https://host/path` | `WebDavVault` | revalidate listing/ETags |
| `s3://bucket/prefix` | `S3Vault` | revalidate listing/ETags |

The OSS default for HTTP mode is **git-pull**:

```sh
SOURCE_VAULTS="notes=git+https://git.example.com/me/notes.git#main"
```

The server clones into a cache under `DATA_DIR/source-cache/` on first use and
fast-forwards it on an interval. Because sources are **read-only**, a periodic
re-pull is sufficient and correct — there is never a push and never a merge.
See [`transports.md`](./transports.md) for why read-only sources need no merge
logic, and [`brain-vault.md`](./brain-vault.md) for the one-way data model.

The `name=path:glob1|glob2` index-allowlist syntax works for transport-backed
sources too:

```sh
SOURCE_VAULTS="notes=git+https://git.example.com/me/notes.git#main:Public/**"
```

## 5. Environment variables

| Var | Required | Meaning |
|-----|----------|---------|
| `BRAIN_VAULT` | recommended | Sole write target. Defaults to a per-user data dir; in a server deployment set it explicitly (e.g. `/data/brain`). |
| `SOURCE_VAULTS` | no | Read-only sources: `name=path[:globs]`, comma-separated. Path may be a `git+`/`webdav+`/`s3://` spec. |
| `API_KEY` | yes (HTTP) | Static Bearer token. |
| `PUBLIC_URL` | OAuth | External base URL for OAuth metadata/callbacks. |
| `PROXY_AUTH` | no | Trust an upstream forward-auth proxy (optional). |
| `API_PORT` | no | HTTP listen port (default `3000`). |
| `DATA_DIR` | no | SQLite cache, HNSW index, and `source-cache/` for git clones. |
| `ENABLE_EMBEDDINGS` | no | Semantic search; `false` = lexical-only (default `true`). |
| `EMBEDDING_MODEL` | no | Override embedding model id. |
| `ENABLE_RERANKER` | no | Optional reranker (default `false`); no default host/model. |
| `DREAM_SCHEDULE` | no | Cron expression for memory consolidation; empty disables. |
| `LOG_LEVEL` | no | `info` (default), `debug`, … |

See [`packages/server/.env.example`](../packages/server/.env.example) for the
authoritative list. Deprecated `VAULT_RW` / `VAULT_RO_*` names are still honored
for one release with a warning and map onto `BRAIN_VAULT` / `SOURCE_VAULTS`.

## 6. Connecting the CLI

```sh
cortexmd auth oauth-login --server https://mcp.example.com   # or:
cortexmd auth login --server https://mcp.example.com --api-key "$MCP_API_KEY"
cortexmd /path/to/repo                                        # index over HTTP
```

Tokens are cached per-user and refreshed transparently; see
[`crates/cli/README.md`](../crates/cli/README.md).
