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

`SEARCH_BACKEND` selects the lexical backend (default `minisearch`). The
SQLite/FTS5 backend (`src/lib/lexical-sqlite.ts`, default
`<DATA_DIR>/lexical.sqlite`) sits behind the `LexicalBackend` interface
(`src/lib/lexical/types.ts`):

| Mode | Lexical arm answered by | MiniSearch built | SQLite DB |
|------|-------------------------|------------------|-----------|
| `minisearch` (default) | MiniSearch | yes | not opened |
| `shadow` | MiniSearch | yes | synced in the background; sampled queries replayed after the response |
| `sqlite` | SQLite (`lexicalSearch` + document frequencies) | no | synced before the index reports ready |

In every mode `docMeta` still holds note bodies (`content`); dropping them is
the next stage. Wiring (`lib/search.ts`): the backend is opened once at the
first `rebuildIndex()`; each scan hands its listing (path, vault, mtime) to
`syncFromListing` (unchanged mtime → skip, unchanged sha1 → touch, else
re-index, unlisted → delete; incremental scans reuse the bytes they already
read); `indexNote` / `removeFromIndex` call `upsert` / `remove`; records come
from the same `metadataForNote` as `docMeta` (`noteRecordFor`). In `sqlite`
mode `lexicalSearch` pushes the SQL-safe scope filters (type, category,
temperature, importance, heat, collection, tags, path prefix, archived) into
the query, re-checks every hit with `passesFilters` (dates, kinds and
`filter()` stay in JS) and deepens the fetch if those drop hits; `coverage` /
`lexicalEvidence` use the backend's document frequencies.

**Failure handling.** If the DB cannot be opened (or `LEXICAL_ANALYZER=legacy`
is set) the server logs one error, serves MiniSearch and reports the reason
in `/health` → `searchBackend.degraded`. In `sqlite` mode a failed sync demotes
to MiniSearch the same way (a full MiniSearch build runs immediately). In
`shadow` mode every backend error (sync, upsert, replayed query) is logged and
counted but can never reach a result.

**Shadow stats.** A lexical query is sampled with probability
`SEARCH_SHADOW_SAMPLE_RATE` (default 0.25) and replayed against SQLite in a
`setImmediate` after the caller has its answer, with at most
`SEARCH_SHADOW_MAX_PENDING` (2) queued (excess samples are dropped and
counted). Only aggregates are kept (`lib/lexical/shadow.ts`): top-10 overlap,
top-1 agreement, share of identical top-10s, p50/p95 latency of both backends
(last 1000 samples), errors, dropped. They are in the authenticated `/health`
(`searchBackend.shadow`), the dashboard Retrieval tab (Lexical Backend card)
and one `Lexical shadow comparison` log line per 500 queries. Read them as:
overlap ≥ 0.9 with top-1 ≥ 0.9 means the two rank alike; the residual
differences are the known gaps below. Never query text or paths.

**Measured (9.6k-note real vault, 262 labelled queries, `npm run eval:recall`).**
`minisearch` and `shadow` reproduce the baseline exactly (every per-query
score identical); shadow agreement on that run: top-10 overlap 0.94, top-1
0.96. `sqlite`: `memory_recall` R@5 90.6 % vs 92.0 %, MRR 0.881 vs 0.884
(10 of 262 queries move; identifier / multi-hop / french-xling lose one query
each, entity −3 pt). The residual gap is long "matches-everything" notes:
prefix/fuzzy expansion groups are still ranked by FTS5's length normalisation
under a depth cut, and a note bigger than `LEXICAL_MAX_INDEXED_KB` is only
indexed up to the cap, so MiniSearch's ×(matched terms) bonus for such a note
is lost — one recall query then falls under the evidence floor and abstains.
Latency is the bigger cost: lexical queries ~2x, `memory_recall` p50 63 vs
24 ms. Heap after build (embeddings off): 100 MB vs 177 MB; warm boot-to-ready
4.7 s vs 10.9 s; first build 20 s; DB 53 MB. Not ready to be the default.

**Schema (v2).** `notes` (path, vault, mtime, sha1, title, body, filter
columns, caller JSON `extra`, per-field FTS5 token counts and MiniSearch
field lengths) · `note_tags(tag, note_id)` · one contentless
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
`bm25()` over every note containing it; for an exact term the term frequency
is recovered from bm25 (FTS5 normalises by token count) and re-scored with
MiniSearch's BM25+ (idf = ln(1+…), k = 1.2, b = 0.7, d = 0.5) and MiniSearch's
field length (unique raw tokens, a much milder long-note penalty) × the field
boost (title 3, content 1, tags 2). Without this re-normalisation long notes
ranked far lower than in MiniSearch, which moved recall's evidence floor; with
it the same note scores within a few % in both backends (median ratio ≈ 1.0).
Prefix (≥3 chars,
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

**Rollout.** `minisearch` (default) → `shadow` (watch the aggregates on the
live vault) → `sqlite` with `docMeta.content` kept (this release) → `sqlite`
with `docMeta.content` dropped once every body consumer reads through a
`getNoteBody(path)` accessor (not started).

**Operations.** Keep the DB on a local disk: WAL needs shared memory and is
unsafe on NFS/SMB volumes. The first build (no DB yet, or after a schema /
analyzer / `LEXICAL_MAX_INDEXED_KB` change, which rebuilds it) indexes the
whole vault and takes longer than a MiniSearch build; later boots skip
unchanged files by mtime. In `shadow` mode that build runs in the background;
in `sqlite` mode readiness waits for it. Deleting `lexical.sqlite*` is always
safe (full rebuild on next boot). On Windows the DB file cannot be deleted
while open. Roll back by unsetting `SEARCH_BACKEND` (or setting `minisearch`)
and restarting; the DB file can stay.
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
