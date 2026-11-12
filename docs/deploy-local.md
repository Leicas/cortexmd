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
are all irrelevant — there is no network surface to protect. `--stdio` starts
no HTTP listener and no dashboard; stdout carries only MCP JSON-RPC frames and
every log line goes to stderr (your client's MCP log). The lexical index is
built before the first request is served; embeddings and the link graph build
in the background, exactly as in HTTP mode. The process exits when the client
closes stdin. Set `DATA_DIR` to a writable per-user directory (its built-in
default, `/app/data`, is the Docker path).

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
| `EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model id (transformers.js / ONNX, CPU). Known presets set dimension, pooling and prefixes automatically: `Xenova/multilingual-e5-small`, `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, `onnx-community/embeddinggemma-300m-ONNX`, `onnx-community/Qwen3-Embedding-0.6B-ONNX`. Each model + dimension keeps its **own index file**, so a switch re-embeds the vault in the background (semantic search fills in as it goes) and switching back is instant. See [BENCHMARKS.md](BENCHMARKS.md#embedding-models-chunking-and-the-local-cross-encoder). |
| `EMBEDDING_DIMENSION` / `EMBEDDING_POOLING` / `EMBEDDING_QUERY_PREFIX` / `EMBEDDING_DOC_PREFIX` / `EMBEDDING_DTYPE` | from the model preset (`384` / `mean` / none / none / `q8`) | Only needed for a model without a preset. Pooling: `mean`, `cls`, `last_token` or `sentence_embedding`. The dimension is also auto-detected from the model's first output. |
| `EMBEDDING_CHUNKING` | `on` | Chunk-level vectors: notes longer than ~1,000 chars get one vector per ~200-token heading-aware section (plus the whole-note lead vector), so text deep in a long note is reachable semantically. `off` = one vector per note. Tunables: `EMBEDDING_CHUNK_CHARS` (800), `EMBEDDING_CHUNK_OVERLAP` (120), `EMBEDDING_MAX_CHUNKS` (24 per note), `EMBEDDING_CHUNK_ROLLUP` (`max`|`top2`). An existing index migrates incrementally in the background. |
| `ENABLE_RERANKER` | `false` | Optional LLM reranker. No default host/model — opt-in only. |
| `ENABLE_CROSS_ENCODER` | `false` | **Experimental, not wired into recall** (on the real-vault eval it added ~1.2 s p50 and lowered top-1; see BENCHMARKS.md). Local ONNX cross-encoder reranker module (`CROSS_ENCODER_MODEL`, default `Xenova/ms-marco-MiniLM-L-6-v2`; `CROSS_ENCODER_TOP_K` 30, `CROSS_ENCODER_TIMEOUT_MS` 800). Lazy-loaded on first use. |
| `DREAM_SCHEDULE` | (empty) | Cron expression for memory "dream" consolidation. Empty disables it. |
| `DATA_DIR` | per-user data dir | Where the SQLite cache + HNSW index live. |
| `LOG_LEVEL` | `info` | `debug`, etc. |
| `TOOL_PROFILE` | `standard` | Which tools `tools/list` advertises. `standard` = 18 tools (~5k tokens): wakeup/recall/store, notes get/search/upsert, diary append/read, step-by-step `code_*` nav, `tool_search` + `tool_invoke`. Every other tool stays callable through `tool_invoke(name, arguments)` (find it with `tool_search`). `full` advertises all ~87 tools (~22k tokens, the pre-1.21 default); `chatgpt` = `standard` + `search`/`fetch`; `tiny`/`nav`/`core`/`lean` still work. Legacy name: `OBSIDIAN_TOOL_PROFILE`. |
| `CHATGPT_SEARCH_FETCH` | `false` | Also register the ChatGPT connector `search`/`fetch` pair under any profile. |

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
