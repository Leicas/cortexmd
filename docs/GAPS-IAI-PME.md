# Gap analysis — cortexmd vs. iai-pme (2026-06-23)

A competitive gap analysis of **cortexmd** against
[**iai-pme** (Independent Autistic Intelligence — Personal Memory Engine)](https://github.com/CodeAbra/iai-personal-memory-engine),
a local, MCP-based long-term memory engine for AI coding assistants.

> **Method & caveat.** cortexmd was read from source in this repo. iai-pme was
> assessed from its public README and `BENCHMARKS.md` (its source was not
> inspected), so its capability claims are taken at face value and may be
> partly aspirational/marketing. Numbers below are theirs unless stated.

## TL;DR

The two projects optimise for **different things**, and most of the divergence
is philosophy rather than missing work:

- **cortexmd** is a *transparent, multi-surface brain*: plaintext Obsidian
  vault, code navigation, a web dashboard, multi-agent sharing, and two
  deployment modes. It treats memory as an **editable folder of Markdown**.
- **iai-pme** is a *sealed, single-user recall optimiser*: encrypted SQLite,
  hyperdimensional structural recall, Leiden community detection, and an
  idle-triggered "sleep" consolidation FSM, with **published reproducible
  benchmarks**.

cortexmd already **leads decisively** on breadth (code-nav, dashboard, graph,
multi-agent, remote transports, open vault). The real gaps are concentrated in
**retrieval science, at-rest privacy, and published evidence** — areas where
iai-pme has made deliberate, measurable bets.

---

## Where cortexmd already leads

| Capability | cortexmd | iai-pme |
|---|---|---|
| **Code navigation** (symbol search, call graph, change-impact, dead code, semantic dup, breaking-change) | ✅ Rust indexer + `code-nav` tools | ❌ none |
| **Web dashboard** (overview / vault / intelligence / graph / sessions) | ✅ | ❌ CLI-only |
| **Graph visualisation & traversal** (`graph_neighbors`/`traverse`/`bridges`/`orphans`/`broken-links`) | ✅ | partial (internal graph, no UI) |
| **Multi-agent / teams** (agents, diaries, team dispatch, shared memory) | ✅ | ❌ single-user |
| **Deployment modes** | local-stdio **and** self-hosted HTTP (OAuth2/API-key) | local-stdio only |
| **Remote source transports** (git / WebDAV / S3, `IVault` seam) | ✅ | ❌ "data lives where the engine runs" |
| **Open, inspectable store** (Markdown + wikilinks + frontmatter) | ✅ no lock-in | ❌ opaque encrypted DB |
| **Temporal KG with invalidation** (`kg_invalidate`/`timeline`) | ✅ | partial (graph decay only) |
| **Multilingual potential** | swappable `EMBEDDING_MODEL` | ❌ English-only by design |

---

## Real gaps (cortexmd is behind or lacks the capability)

| # | Gap | What iai-pme does | cortexmd today | Effort | Deliberate non-goal? |
|---|-----|-------------------|----------------|--------|----------------------|
| 1 | **Structural / hyperdimensional recall** | "Lilli HD" — retrieve by the *shape* of a memory, not just embedding cosine; distinct HD representations per memory type. Plausibly drives their **Rescue@10 = 1.000** (current fact still ranks top-10 after being contradicted). | Recall is lexical + dense-embedding only. | **L** | No — genuine retrieval-architecture gap. |
| 2 | **Multi-signal recall fusion** | Ranks **semantic similarity + graph-link strength + recency together** in one hot-path scorer. | `search.ts` fuses **only lexical + semantic** via RRF (+ collection boost, optional reranker). Heat/recency and the graph live in *separate* lifecycle/KG layers, not in the query-time ranker. | **M** | No — folding heat + link-strength into ranking is a clear win. |
| 3 | **Encryption at rest** | All records AES-256-GCM encrypted; key at `~/.iai-mcp/.key` (mode 0600). | Plaintext Markdown by design (the "open vault" selling point). No at-rest confidentiality. | **M** | Partly — openness is the thesis, but an **opt-in encrypted brain-vault** backend would close a real threat-model gap without abandoning the default. |
| 4 | **Procedural memory (self-tuning preferences)** | "Eleven sealed knobs" — stable user parameters (style, preferences, recurring patterns) that **shift based on what works** over time. | Has a `preference-detector` and `fact`/`preference` categories, but no adaptive, self-tuning procedural-parameter layer. | **M** | No — a small, bounded self-tuning profile is a natural add. |
| 5 | **Verbatim write-once episodic guarantee** | Episodes are "write-once, never overwritten or rewritten"; refuses to "smooth rare events into typical ones." | Auto-consolidation **merges + deletes** originals; decay mutates frontmatter. `isProtectedFromConsolidation` guards some classes, but unique cold notes *can* be folded away. | **S** | Partly — but an immutable episodic tier (consolidation produces *derived* semantic notes, never destroys source) would be safer and matches their lossless stance. |
| 6 | **Graph community detection for clustering** | "MOSAIC" — a Leiden-family method (CPM objective) clusters the memory graph for coherent episode replay. | Dream clustering is shared-**tag** union-find + tag-pair co-occurrence — far cruder than graph community detection. | **M** | No — Leiden/Louvain over the existing link graph would materially improve theme/consolidation quality. |
| 7 | **Published, reproducible benchmarks** | Ships LongMemEval-S (**R@5 0.966**, tie with mempalace), **Rescue@10 1.000**, personal-fact drift 0.9933, latency (p50 77 ms @1k / 368 ms @10k), RSS 589 MB @10k, session-start token budget <3 000 — all with runnable harnesses. | `lib/benchmark.ts` + `benchmark_run` exist but results are **unpublished** (also flagged in MEMPALACE-PARITY #4). | **M** | No — running + publishing honest R@k / latency / footprint is pure credibility upside. |
| 8 | **Idle-triggered consolidation FSM** | Explicit state machine (WAKE → DROWSY → SLEEP → HIBERNATION; engine WAKE/TRANSITIONING/SLEEP/DREAMING). Drains the capture buffer through *shield → embed → dedup → encrypted insert* on the **5-min idle edge**; works offline without the daemon running. | Dream cycle is **cron-scheduled** (`DREAM_SCHEDULE`) or manual; no idle-edge trigger, no offline-while-engine-down path. | **M** | No — an idle/activity-driven trigger would consolidate more promptly and cheaply. |
| 9 | **Zero-RPC in-session capture** | Turn capture is "pure file IO ... **zero engine RPC during the session**"; all heavy work deferred to the idle drain. | Recall/capture hooks call back into the MCP server during the session (`cortexmd recall --hook`). | **S** | Maybe — a pure-append session buffer drained later would cut per-turn latency. |
| 10 | **Single-binary install / footprint profile** | One local engine; publishes a concrete resource envelope. | Needs a **Node build + Rust `cargo build`**; no published footprint/latency profile (MEMPALACE-PARITY #1 still open). | **L** | No — the biggest adoption blocker; ship a prebuilt bundled distribution. |

---

## Notable differences that are *not* gaps (deliberate divergence)

- **Opaque encrypted DB vs. open Markdown vault.** iai-pme's encryption buys
  confidentiality at the cost of inspectability; cortexmd bets the opposite.
  Both are valid — see gap #3 for the opt-in middle path.
- **English-only embedder (bge-small-en-v1.5) vs. swappable model.** iai-pme
  translates everything to English on the way in *on purpose*. cortexmd keeps
  `EMBEDDING_MODEL` swappable (default `Xenova/all-MiniLM-L6-v2`), enabling
  multilingual vaults — a cortexmd advantage, not a gap.
- **Single-user vs. multi-agent/shared.** iai-pme is explicitly one person, one
  machine. cortexmd's teams/agents/HTTP mode are out of iai-pme's scope.

---

## Prioritised roadmap (highest leverage first)

1. **Publish honest benchmarks** (gap #7, **M**). Lowest-risk, highest-trust
   move — the harness already exists. State the embedding model; separate
   retrieval-recall from end-to-end QA; include a Rescue@10-style
   contradiction test so the #1/#2 retrieval gaps are *measured*, not asserted.
2. **Fold recency + graph-link strength into the recall ranker** (gap #2, **M**).
   cortexmd already computes heat and the link graph; wiring them into
   `search.ts` ranking is mostly plumbing and likely the single biggest
   quality win available without new ML.
3. **Immutable episodic tier + Leiden consolidation** (gaps #5 + #6, **S+M**).
   Make consolidation produce *derived* semantic notes that link back to
   never-deleted episodes, and cluster via community detection over the link
   graph instead of tag union-find.
4. **Opt-in encrypted brain-vault backend** (gap #3, **M**). Add an encrypted
   `IVault` write implementation behind a flag; keep plaintext the default.
5. **Idle-edge dream trigger + zero-RPC session buffer** (gaps #8 + #9, **M+S**).
   Trigger consolidation on an activity/idle signal and defer in-session
   capture to a pure-append buffer drained at idle.
6. **Self-tuning procedural profile** (gap #4, **M**) and **single-binary
   distribution** (gap #10, **L**) — larger bets, sequence after the above.

## Status

- [ ] Benchmarks published with honest methodology (gap #7)
- [ ] Recency + graph-link strength fused into recall ranking (gap #2)
- [ ] Immutable episodic tier; consolidation never deletes source (gap #5)
- [ ] Community-detection clustering in the dream cycle (gap #6)
- [ ] Opt-in encrypted brain-vault backend (gap #3)
- [ ] Idle-edge consolidation trigger + zero-RPC session buffer (gaps #8, #9)
- [ ] Structural/HD recall investigation (gap #1) — research spike
- [ ] Self-tuning procedural profile (gap #4)
- [ ] Single-binary distribution (gap #10)
