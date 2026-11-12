# cortexmd architecture

> Pre-alpha. This documents the target design, not necessarily everything wired up today.

## 1. The brain-vault data-flow model

cortexmd separates **what it reads** from **what it writes**, and that separation is the central design decision.

- **BRAIN_VAULT** — a vault that cortexmd *owns*. It is the **sole write target**: memories, journal entries, agent diaries, tasks, knowledge-graph notes, and `code-repos.json` all live here. It defaults to a dedicated data directory (e.g. `~/.local/share/cortexmd/brain`), explicitly **not** the user's Obsidian vault.
- **SOURCE_VAULTS[]** — zero or more of the user's own vaults, attached **read-only**. They are indexed (lexical + semantic + code-nav) but never modified. Opt-in, with a default-deny index allowlist so private subtrees can be excluded.

```
  read (one-way)                         write (only here)
  ┌────────────────────┐                ┌──────────────────┐
  │   SOURCE_VAULTS[]   │   index        │    BRAIN_VAULT    │
  │  (your vaults, RO)  │ ─────────────▶ │  (owned by server)│
  └────────────────────┘    via IVault  └──────────────────┘
           ▲                                      ▲
           │                                      │
           └──────────── cortexmd MCP server ─────┘
                          (sole writer)
```

### Why this dissolves the sync hazard

The private predecessor used `VAULT_RW` + `VAULT_RO_*` and relied on bidirectional file sync (Resilio/Syncthing) into the same vault the user edited. That creates clobber/merge races between the human, the sync agent, and the server. *(This was observed live: a one-time filesystem reorganization on one peer, combined with the server's own heat/reindex writes, produced duplicated notes that the sync couldn't reconcile.)*

By making the server the **single writer** of a vault it **owns**, and treating every user vault as a **read-only source**, all data flow is one-directional. There is no shared mutable file, so there is no merge logic and no clobber: the user edits their vault, cortexmd re-reads it; cortexmd writes only into the brain. The sync problem doesn't need solving — it's designed out.

## 2. Dual-mode deployment

Two co-equal modes share the same core; only transport and auth differ.

| | local-stdio (default) | self-hosted HTTP (advanced) |
|---|---|---|
| Transport | MCP over stdio | Express HTTP (`/mcp`) |
| Vault read | local filesystem, direct | `IVault` (git pull / WebDAV / S3) on an interval |
| Auth | none (local trust) | API key or OAuth2; Authelia/Traefik forward-auth optional |
| Sync / Docker | none | optional |
| Audience | single user on one machine | multi-client / remote |

The server selects mode at startup (e.g. `--stdio` vs binding an HTTP port). All search, memory, and code-nav logic is mode-agnostic.

## 3. The IVault transport seam

Vault access is hidden behind an `IVault` interface so the source of bytes is pluggable:

```ts
interface IVault {
  list(): Promise<string[]>;            // relative paths (allowlist-filtered)
  read(path: string): Promise<Buffer>;  // read-only for source vaults
  // write(...) exists ONLY for the brain vault implementation
  refresh(): Promise<void>;             // re-sync underlying source (no-op for Local)
}
```

Implementations:

- **Local** — direct filesystem reads. `refresh()` is a no-op (the OS already has the latest bytes). Used by local-stdio mode and for the brain vault.
- **Git** — the OSS default for HTTP mode: `git pull` a vault repo on an interval, then read the working tree. Because sources are read-only, a periodic re-pull is sufficient — there is never a push, never a merge of local edits.
- **WebDAV / S3** — future remote read backends behind the same interface.

Only the brain-vault implementation exposes writes; source-vault implementations are read-only by type, enforcing the one-way model at the seam.

## 4. Core subsystems (mode-agnostic)

- **Hybrid search** — MiniSearch (lexical, fuzzy + field boosting) fused with HNSW semantic results via Reciprocal Rank Fusion; collection weights further boost scores.
- **Memory lifecycle** — heat scoring (recency + access + links), per-category TTL decay, auto-archival, contradiction detection, consolidation. Auto-stored memories embed `[[wiki-links]]` to detected entities so they join the graph instead of orphaning.
- **Code navigation** — symbol DB fed by the Rust indexer over the `contract/` wire format; serves symbol search, outlines, call graph, change-impact, duplicate/dead-code detection. ~60 tokens/result vs whole-file reads.
- **Collections** — path-pattern classification with per-collection search weighting; shipped as customizable examples, not baked-in personal taxonomy.

## 6. Lexical index storage: MiniSearch vs SQLite/FTS5

Markdown files stay the source of truth; every index is derived. Today the
lexical index is MiniSearch in the V8 heap (~100 MB at ~10k notes) plus every
note body in `docMeta` (~66 MB), which makes the 1 GB container cap a wall
around 18–20k notes.

> **Status: not wired.** MiniSearch is the only active backend. The SQLite
> backend below is implemented and tested in isolation, but `search.ts` does
> not use it yet (at the current vault size its queries measured about 2x
> slower). `SEARCH_BACKEND=sqlite` / `shadow` are reserved for this rollout:
> today they only log a warning at boot and the server keeps using MiniSearch.

The planned `SEARCH_BACKEND=sqlite` moves both to an on-disk SQLite
database (`src/lib/lexical-sqlite.ts`, default `<DATA_DIR>/lexical.sqlite`)
behind the `LexicalBackend` interface (`src/lib/lexical/types.ts`).

**Schema (v1).** `notes` (path, vault, mtime, sha1, title, body, filter
columns, caller JSON `extra`) · `note_tags(tag, note_id)` · one contentless
FTS5 table per field (`f_title`, `f_content`, `f_tags`, `contentless_delete=1`)
so BM25 length normalisation and document frequencies are per field like
MiniSearch's (a single 3-column table normalises by whole-note length and
measurably lost ranking parity) · `v_*` (fts5vocab: document frequency +
prefix expansion) · `vocab`/`vgram` (padded-trigram index for fuzzy) ·
`meta(schema_version, analyzer)`.

**Analyzer parity.** The shared bilingual analyzer (`lib/text-analyzer.ts`)
runs in JS before insert and at query time, exactly like MiniSearch's
`processTerm`; FTS5 only splits on spaces (`ascii` tokenizer, non-`[a-z0-9]`
characters spelled `_hex_`). The analyzer is fingerprinted (its output on a
fixed probe text); a fingerprint or `LEXICAL_SCHEMA_VERSION` change drops and
rebuilds the DB on open. FTS5's built-in `unicode61 remove_diacritics 2`
(± porter) was benchmarked and rejected: lower recall on the real query set and
no stopword/elision handling (numbers: `scripts/bench-lexical.ts`).

**Query model.** Each analysed query term is scored per field with FTS5
`bm25()`; for an exact term the tf component is recovered (÷ FTS5's idf) and
re-scored with MiniSearch's BM25+ (idf = ln(1+…), d = 0.5) × the field boost
(title 3, content 1, tags 2); prefix (≥3 chars,
up to 64 vocabulary expansions) and fuzzy (≥5 chars, MiniSearch's edit
distance, candidates from the trigram index, verified by Levenshtein) groups are
down-weighted 0.375 / 0.45 like MiniSearch; per-note sums are multiplied by the
number of matched query terms (MiniSearch "quality"). Filters (type, category,
temperature, heat, importance, tags, date range, path prefix, collection,
archived) are SQL `WHERE` clauses, so filtered queries are never starved.

**Sync.** `syncFromListing` reconciles against the vault listing: unchanged
mtime → skip; unchanged sha1 → touch mtime; else re-parse and re-index; unlisted
→ delete. Hashing/parsing/analysis run outside transactions (big notes in
64 KB pieces); writes run in `BEGIN IMMEDIATE … COMMIT` slices bounded by
`LEXICAL_SYNC_SLICE_MS` (25 ms; half for rows, the rest for COMMIT's FTS flush
and bounded FTS5 `merge` steps — `automerge` is off) with a yield between
slices. SQLite's in-line WAL auto-checkpoint was the main source of 50–150 ms
stalls, so it is disabled and a small worker thread runs PASSIVE checkpoints
when the WAL passes 16 MB. Every note's
row + FTS + tags commit together, so a crash between slices leaves a consistent
DB the next sync continues. Bodies beyond `LEXICAL_MAX_INDEXED_KB` (256) are
stored but not indexed (a 5 MB dump's FTS insert alone blocks ~0.3–1 s).
A warm boot reads metadata back with `forEachNote` instead of re-reading files.

**Rollout.** `minisearch` (default) → `shadow` (MiniSearch answers; FTS5 runs
the same lexical query and `lib/lexical/shadow.ts` logs only aggregate top-10
overlap / top-1 agreement / latency, never queries or paths) → `sqlite` with
`docMeta.content` kept → `sqlite` with `docMeta.content` dropped once every
body consumer reads through a `getNoteBody(path)` accessor.

**Operations.** Keep the DB on a local disk: WAL needs shared memory and is
unsafe on NFS/SMB volumes. Deleting `lexical.sqlite*` is always safe (full
rebuild on next boot). On Windows the DB file cannot be deleted while open.
The bundled SQLite of `better-sqlite3` 11.10 (3.49.2) is compiled with FTS5
and ships the trigram tokenizer; the Docker image compiles the same
amalgamation from source.

## 7. Boundaries to preserve

- No hardcoded hosts, domains, or vault paths in defaults.
- Neutral MCP tool namespace (no org-specific prefix).
- Reranker hardware and models fully optional, no default endpoint.
- Authelia/Traefik documented as optional; API key or OAuth work standalone.
- Write-routing: every write resolves into `BRAIN_VAULT`, and the containment check must resist symlink escape (realpath, not string-prefix).
- Symbol-ID algorithm identical across Rust and TS, enforced by `contract/` golden fixtures.
