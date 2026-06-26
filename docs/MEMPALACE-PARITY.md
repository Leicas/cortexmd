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

## Correction: two "gaps" already exist (the recon agent couldn't see `crates/cli`)

The first audit pass listed "per-message recall hook" and "one-command install" as gaps.
Inspecting `crates/cli` + `docs/hooks.md` shows **both already ship**:

- **Per-message recall (= mempalace `sweep`)** — the `UserPromptSubmit` "Memory recall" hook
  (`cortexmd recall --hook`) already tokenizes each prompt, recalls the top matching
  memories/notes, and injects them as context. This is the sweep equivalent.
- **One-command Claude wiring** — `cortexmd init` already writes `CORTEXMD.md`, references it
  from `CLAUDE.md`, drops the hook scripts, and idempotently patches `settings.json`.

So the real remaining surface is narrower than the first pass implied.

## Real gaps & prioritized roadmap

| # | Gap | Effort | Status |
|---|-----|--------|--------|
| 1 | **One-command *server* bring-up** — `cortexmd init` wires the client, but the server still needs a Node build **and** a Rust `cargo build` to run | **L** | Open — biggest adoption blocker. Ship a prebuilt distribution (single bundled binary incl. the Rust indexer, or a published image) so `docker compose up` / one binary is the whole story. |
| 2 | **Compact L0 floor + low startup budget** (~900 → sub-200) | **S** | **Done** — `memory_wakeup` now takes `preset: tiny` (~180) / `standard` / `full`; default unchanged (no recall regression). |
| 3 | **Claude Code plugin** | **M** | **Done** — `plugin/cortexmd/` packages the MCP server + hooks (per-prompt recall/sweep, HUD, code-nav rewrite, capture) + a tools skill; repo is a marketplace (`.claude-plugin/marketplace.json`). `claude plugin validate` passes. |
| 4 | **Published recall benchmarks** | **S now** | **Harness done, publish open** — `benchmark.ts` now has `computeRescueAtK` + R@5/10 + NDCG + p50/p95 and `benchmark_run`; `benchmarkSummary` is already in the dashboard payload but unrendered. Remaining is a committed fixture set, `docs/BENCHMARKS.md`, and a dashboard panel. Recall fusion + Rescue@10 also shipped (2026-06-25 re-audit). |
| 5 | **Honest optional compaction** (instead of AAAK) | **M** | Open — opt-in lossy summarization on **cold** memories only (keep verbatim hot tier); measure the recall delta with the harness; document transparently. |
| 6 | **Multilingual embedding option** | **S** | Mostly docs — already swappable via `EMBEDDING_MODEL` (`config.embeddingModel`); document an `embedding-gemma-300m`-class option for non-English vaults. |

## Status

- [x] Corrected the stale "parity 100% complete" memory note (re-audit appended 2026-06-03).
- [x] Corrected the audit: per-message recall hook + `cortexmd init` already exist.
- [x] Startup-budget presets shipped (`memory_wakeup` `preset`).
- [x] Claude Code plugin + marketplace shipped (`plugin/cortexmd/`, validated).
- [x] **Multi-signal recall fusion + contradiction-aware Rescue@10 + Hebbian co-recall shipped** (2026-06-25; see `GAPS-IAI-PME.md` re-audit) — beyond mempalace's verbatim-store model.
- [x] **Benchmark harness** (Rescue@10, R@k, NDCG, p50/p95, `benchmark_run`) shipped — publication is the remaining step of gap #4.
- [ ] Server one-liner install (1), **publish** benchmarks (4: write `BENCHMARKS.md` + dashboard panel), cold-only compaction (5) — scoped follow-ups.
