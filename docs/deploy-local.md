# Deploy: local-stdio (zero-config)

> The recommended default for individual use. Runs on your machine, talks MCP
> over stdio, reads your vault(s) directly off disk. No Docker, no auth, no
> network, no sync.

If you want the multi-client / remote path instead, see
[`deploy-http.md`](./deploy-http.md). For the data model these docs assume, see
[`brain-vault.md`](./brain-vault.md).

## 1. Build

```sh
cd packages/server
npm ci
npm run build        # tsc -> dist/
```

Node 22 is required (the server is ESM, target ES2022).

## 2. Run

The only thing the server insists on is somewhere to put its **brain vault**
(see [`brain-vault.md`](./brain-vault.md)) — and even that has a default. With
nothing configured, the brain lands in a per-user data directory:

| OS | Default `BRAIN_VAULT` |
|----|------------------------|
| Linux/macOS | `$XDG_DATA_HOME/cortexmd/brain` (else `~/.local/share/cortexmd/brain`) |
| Windows | `%LOCALAPPDATA%\cortexmd\brain` |

It is created automatically on first boot, and it is deliberately **not** inside
any vault you edit.

Minimal run — index one of your own vaults read-only:

```sh
BRAIN_VAULT=~/.local/share/cortexmd/brain \
SOURCE_VAULTS=/path/to/your/vault \
node dist/index.js --stdio
```

`SOURCE_VAULTS` is optional and defaults to empty — the server boots fine with
no source vault at all (memory + KG still work; there's just nothing indexed
yet). See [Configuring source vaults](#4-configuring-source-vaults) below for
the full `name=path:globs` syntax.

In stdio mode `API_KEY`, `PUBLIC_URL`, OAuth, and the reverse-proxy machinery
are all irrelevant — there is no network surface to protect.

## 3. Register with your MCP client

Point your MCP client at the command above as an **stdio** server. Example
(Claude Code / Cursor / Codex style config):

```json
{
  "mcpServers": {
    "cortexmd": {
      "command": "node",
      "args": ["/abs/path/to/cortexmd/packages/server/dist/index.js", "--stdio"],
      "env": {
        "BRAIN_VAULT": "/home/you/.local/share/cortexmd/brain",
        "SOURCE_VAULTS": "/home/you/vault"
      }
    }
  }
}
```

Restart the client; the cortexmd tools (`memory_*`, `notes_*`, `code_*`, …)
appear under the neutral `mcp__cortexmd__*` namespace.

## 4. Configuring source vaults

`SOURCE_VAULTS` is a comma-separated list. Each entry is one of:

- a bare path — `~/vault` (the basename becomes the label), or
- `name=path` — `perso=/data/perso`, or
- `name=path:glob1|glob2` — a path plus a **default-deny index allowlist**.

```sh
SOURCE_VAULTS="perso=/data/perso,work=/data/work-kb:Projects/**|Notes/**"
```

When a source vault declares globs, **only** vault-relative paths matching one
of them are walked, indexed, or embedded — a per-source privacy filter. A
source with no globs is fully indexable. The segments `.obsidian`, `.sync`, and
`.trash` are hard-blocked regardless of any glob. See
[`brain-vault.md`](./brain-vault.md#the-allowlist) for the rationale.

In local-stdio mode every source vault is a plain filesystem path. The
`git+`/`webdav+`/`s3://` transport schemes are an HTTP-mode concern — see
[`transports.md`](./transports.md).

## 5. Index a repo for code-nav

Code navigation (symbol search, call graph, change-impact) is fed by the Rust
CLI, which parses a repo with tree-sitter and ships the symbols to the server's
`code_ingest_repo` tool.

```sh
cd crates/cli
cargo build --release
./target/release/cortexmd /path/to/some/repo        # index one repo
./target/release/cortexmd scan /path/to/dev-root    # walk + index every git repo
./target/release/cortexmd status                    # what's registered + savings
```

In local mode the CLI talks to the same local server. Indexed languages:
`.ts .tsx .js .jsx .py .rs .go` (plus C/C++). `node_modules`, `dist`, `.git`,
`target`, etc. are skipped, and `.gitignore` is honoured.

## 6. Optional features

All off-by-default-friendly; none required for a working local install.

| Env var | Default | Effect |
|---------|---------|--------|
| `ENABLE_EMBEDDINGS` | `true` | Semantic search (HNSW + transformers). Set `false` for a **lexical-only** fast path on low-resource machines — avoids the first-run model download and HNSW build. |
| `EMBEDDING_MODEL` | (built-in) | Override the embedding model id. |
| `ENABLE_RERANKER` | `false` | Optional LLM reranker. No default host/model — opt-in only. |
| `DREAM_SCHEDULE` | (empty) | Cron expression for memory "dream" consolidation. Empty disables it. |
| `DATA_DIR` | per-user data dir | Where the SQLite cache + HNSW index live. |
| `LOG_LEVEL` | `info` | `debug`, etc. |

See [`packages/server/.env.example`](../packages/server/.env.example) for the
authoritative list.

## Troubleshooting

- **First run is slow / hangs on startup.** That's the embeddings model
  downloading and the HNSW index building. Set `ENABLE_EMBEDDINGS=false` to skip
  it, or just wait it out once — subsequent boots reuse the cache in `DATA_DIR`.
- **Nothing shows up in search.** You probably have no `SOURCE_VAULTS`, or your
  allowlist globs exclude everything. Drop the `:globs` suffix to index the
  whole vault.
- **Writes failing / "not in brain vault".** That's the safety invariant doing
  its job — the server only ever writes inside `BRAIN_VAULT`. See
  [`brain-vault.md`](./brain-vault.md).
