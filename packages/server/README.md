# @cortexmd/server

The TypeScript MCP server. This is the runtime that agents connect to: it indexes source vaults, owns the brain vault, runs hybrid search, manages the memory lifecycle, and exposes ~17 MCP tools plus an optional HTTP API.

## Runtime

Node 22, ESM (`"type": "module"`), TypeScript strict mode, target ES2022. All intra-project imports use `.js` extensions (NodeNext resolution).

## Build & run

```sh
npm ci
npm run build      # tsc -> dist/
npm run dev        # tsx --watch src/index.ts
npm test           # vitest
```

### local-stdio mode (default)

Reads vaults directly from disk, speaks MCP over stdio, no auth/network:

```sh
BRAIN_VAULT=~/.local/share/cortexmd/brain \
SOURCE_VAULTS=/path/to/vault \
node dist/index.js --stdio
```

### HTTP mode (advanced)

Express server with Bearer-token / OAuth2 auth; source vaults pulled read-only on an interval via the `IVault` transport:

```sh
BRAIN_VAULT=/data/brain SOURCE_VAULTS=/data/sources/* API_KEY=... \
node dist/index.js     # listens on :3000
```

## Environment variables

| Var | Required | Meaning |
|-----|----------|---------|
| `BRAIN_VAULT` | yes | The sole write target (memories, journal, diaries, tasks, KG, `code-repos.json`). Default a non-vault data dir, **not** your Obsidian vault. |
| `SOURCE_VAULTS` | no | Comma- or glob-separated read-only vault paths to index. Zero-to-many, opt-in. |
| `SOURCE_VAULT_ALLOWLIST` | no | Glob allowlist of paths within sources that may be indexed (default-deny privacy filter). |
| `API_KEY` | HTTP only | Static Bearer token. Not needed in stdio mode. |
| `PUBLIC_URL` | HTTP only | External base URL for OAuth callbacks. No hardcoded default. |
| `DATA_DIR` | no | Where SQLite cache + HNSW index live. |
| `ENABLE_EMBEDDINGS` | no | Toggle semantic search (HNSW + transformers). `false` = lexical-only fast path. |
| `EMBEDDING_MODEL` | no | Embedding model id. |
| `LOG_LEVEL` | no | `info` (default), `debug`, etc. |
| `INDEX_REBUILD_INTERVAL_MS` | no | Lexical index rebuild cadence (default 60000). |
| `ENABLE_RERANKER` | no | Optional LLM reranker; provider/host fully optional, no default hardware/model. |

See `.env.example` for the complete list.

## What lives here (planned module map)

- `src/index.ts` — entry point, transport selection (stdio vs HTTP), tool registration.
- `src/lib/` — `search` (MiniSearch), `embeddings` (HNSW), `memory` / `memory-lifecycle`, `collections`, `vault` (safe I/O), `frontmatter`, `graph`, `metrics`, `logger`.
- `src/lib/vault/` — the `IVault` transport seam (Local / git / WebDAV / S3).
- `src/tools/` — one file per MCP tool, each exporting `register(server)`.
- `src/lib/code/parser.ts` — the TS side of the contract symbol-ID algorithm (must match `crates/cli` byte-for-byte; see `../../contract/`).
