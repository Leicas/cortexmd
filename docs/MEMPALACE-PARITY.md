# Mempalace parity — re-audit & roadmap (2026-06-03)

A competitive re-audit of **cortexmd** against [mempalace](https://github.com/mempalace/mempalace)
([guide](https://mempalaceofficial.com/guide/getting-started.html)), refining the earlier
"parity plan 100% complete (2026-04-08, 12 phases)" record.

## TL;DR

Architectural parity **holds and is exceeded**. The remaining gaps are **ergonomic**
(packaging, startup budget, in-session recall, published benchmarks) — not capability.
Do **not** chase mempalace's headline "30× lossless compression" — it is independently
shown to be lossy.

## Where cortexmd already leads

- **Code navigation** — symbol search, file outline, call graph, change-impact, call-chain,
  import cycles, dead code, semantic duplicates, breaking-change detection. Mempalace has none.
- **Web dashboard** — overview / vault / intelligence / **graph** tabs, dream + health views.
  Mempalace ships no dashboard.
- **Richer memory lifecycle** — temperature/heat decay, Bayesian validity posteriors,
  ROI-based demotion + auto-promotion, the dream consolidation engine, and (new) cold-note
  → project reconciliation. Deeper than mempalace's verbatim-store model.
- **Sole-writer brain-vault architecture** — source vaults attach read-only; one-way indexing
  eliminates bidirectional-sync clobber hazards.
- **Already has the L0–L3 stack** (`memory-stack.ts`) and the wings/rooms/drawers taxonomy
  (`vault_taxonomy`) — the "palace" metaphor is already shipped.
- **Temporal KG** matches mempalace (`kg_add`/`query`/`invalidate`/`timeline`/`stats`) and adds
  `graph_neighbors`/`traverse`/`bridges`/`orphans`/`broken-links`.
- **Two deployment modes** incl. self-hosted HTTP with OAuth2/API-key auth and git/WebDAV/S3
  source transports. Mempalace is local-only.

## Reality check on mempalace's headline claims

- **AAAK "30× lossless" compression is LOSSY.** Independent audits + a maintainer correction
  show it regresses LongMemEval recall 96.6% → 84.2% (-12.4 pts). The "lossless" figure used a
  wrong tokenizer heuristic. (GitHub #214.)
- **"96.6% R@5" is ChromaDB's default all-MiniLM embedding** over verbatim chunks — a baseline,
  not an architecture result. (GitHub #29.)

➡ **Strategy:** turn this into a trust advantage — publish *honest* benchmark numbers (we have
the harness) and offer only *measured, opt-in* compaction.

## Real gaps & prioritized roadmap

| # | Gap | Effort | Notes |
|---|-----|--------|-------|
| 1 | **One-command install** — Node build *and* Rust `cargo build` vs mempalace's single `pip install` + `init` | **L** | Ship a prebuilt distribution (npx-runnable or single bundled binary incl. the Rust indexer) + a `cortexmd init` that writes the MCP client config, picks a default `BRAIN_VAULT`, and downloads the embedding model. Biggest real adoption blocker. |
| 2 | **Per-message recall hook** (mempalace `sweep`) | **M** | Add a `UserPromptSubmit`/`PreToolUse` hook that runs a cheap `memory_recall` against the latest message and injects a small top-k snippet. Pairs with the existing recall + reranker. Hook-side (see `docs/hooks.md`), not server core. |
| 3 | **Compact L0 identity floor + low default wakeup budget** (~900 → sub-200 tokens) | **S** | The L0–L3 machinery exists (`memory-stack.ts`); add a `tiny` wakeup preset + an identity-file generator and document a ~150–200 token `IDENTITY_FILE`. Don't lower the global default blindly — gate behind a preset to avoid recall regressions. |
| 4 | **Published recall benchmarks** | **M** | `lib/benchmark.ts` + `benchmark_run` already exist. Run LongMemEval/LoCoMo-style R@k and publish in the README with **honest methodology** (state the embedding model; separate retrieval-recall from end-to-end QA). |
| 5 | **Honest optional compaction** (instead of AAAK) | **M** | Opt-in lossy summarization on **cold** memories only (keep verbatim hot tier); measure the recall delta with the harness and document it transparently. |
| 6 | **Multilingual embedding option** | **S** | Already swappable via `EMBEDDING_MODEL` (`config.embeddingModel`); document an `embedding-gemma-300m`-class multilingual option for non-English vaults. Mostly docs. |

## Status

- [x] Correct the stale "parity 100% complete" memory note (re-audit appended 2026-06-03).
- [x] This roadmap committed.
- [ ] Items 1–6 above — separate, scoped follow-ups (1, 4, 5 are the highest-leverage).
