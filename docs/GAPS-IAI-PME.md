# Gap analysis — cortexmd vs. iai-pme (2026-06-23)

A competitive gap analysis of **cortexmd** against
[**iai-pme** (Independent Autistic Intelligence — Personal Memory Engine)](https://github.com/CodeAbra/iai-personal-memory-engine),
a local, MCP-based long-term memory engine for AI coding assistants.

> **Method.** cortexmd was read from source in this repo. iai-pme was assessed
> from its **public source** (`src/iai_mcp/**`, `rust/**`, `BENCHMARKS.md`), not
> just its README — file-level findings are marked _(verified in source)_.
> Where only the README/benchmark doc asserts something, it is marked _(claimed)_.

## TL;DR

The two projects optimise for **different things**:

- **cortexmd** is a *transparent, multi-surface brain*: plaintext Obsidian
  vault, code navigation, a web dashboard, multi-agent sharing, two deployment
  modes. Memory is an **editable folder of Markdown**. Lean and inspectable.
- **iai-pme** is a *sealed, single-user, neuroscience-inspired recall engine*:
  encrypted SQLite, a real hyperdimensional-computing substrate, Leiden
  community detection, contradiction-aware temporal recall, and published
  benchmarks — built from **~90 Python modules + 3 Rust crates**.

Reading the source changed the picture in both directions. Several README
claims are **real and deep** (HD substrate, Leiden/CPM, AES-256-GCM); one is
**oversold** (the self-tuning "procedural knobs" are largely placeholders). And
iai-pme's headline **Rescue@10 = 1.000** turns out to come from explicit
**contradiction edges + temporal-validity + stale-downweighting at recall
time**, *not* from HD magic — which makes it a concrete, copyable mechanism
rather than an unreachable one.

cortexmd still **leads decisively on breadth** (code-nav, dashboard, graph UI,
multi-agent, remote transports, open vault, cross-platform). The real gaps are
in **retrieval science, at-rest privacy, and published evidence**.

---

## Verified against iai-pme source

| Claim | Verdict | Evidence in source |
|---|---|---|
| **Hyperdimensional "structural recall" (Lilli HD)** | **Real & deep** | `lilli/` exposes three VSA tiers — Binary Spatter Code, FHRR (Fourier Holographic Reduced Representation), sparse VSA — with binding/bundling, `orthogonalize`/`cleanup`, and REM/SWS sleep-replay ops (`run_rem`/`run_sws`/`run_consolidation`). "Retrieve by shape" = encode cue → hypervector → kNN over hypervectors. Cognitive mode hardcoded `"autistic"`. |
| **MOSAIC = Leiden (CPM objective)** | **Real** | `mosaic.py`: `_run_one_leiden_pass`, `_njit_local_move`/`_njit_refine` (numba), `compute_modularity_cpm`/`compute_delta_q_cpm`, `multi_objective_gamma_tuner`, and a `LineageTracker` for community births/splits/merges. |
| **AES-256-GCM at rest** | **Real & solid** | `crypto.py`: AESGCM, 32-byte key, 12-byte random per-record nonce, AEAD with associated data, `iai:enc:v1:` payload. Key at `~/.iai-mcp/.crypto.key` (0600, uid-checked) **or** `IAI_MCP_CRYPTO_PASSPHRASE` → PBKDF2-HMAC-SHA256 **600 000** iters. |
| **Multi-signal recall fusion** | **Real** | `retrieve.py` (~850 LOC): seeds rank by `0.6*cos + 0.4*centrality`; `derive_temporal_validity()` sets `valid_from/valid_to` from contradiction edges; `apply_stale_downweight()` ×0.5 for expired memories. |
| **Rescue@10 = 1.000 (post-contradiction)** | **Real, but mechanistic** | Driven by contradiction edges + temporal-validity windows + stale downweighting (above) and `reconsolidation.py`/`reconsolidation_critic.py` — *not* HD. Copyable. |
| **Self-tuning "11 procedural knobs"** | **Oversold** | `user_model.py`: tracks `top_recent_topics`, `tool_usage_freq`, `time_of_day_pattern`, `recent_projects` via event aggregation + a "surprise boost". `soft_knobs` and `plasticity_gain` exist but are **placeholders with no implementation shown**. Not true self-tuning. |
| **Sleep/idle consolidation FSM** | **Real but spread out / macOS-leaning** | FSM lives across `lifecycle_state.py`, `daemon_state.py`, `fsm_reconcile.py`, `sleep.py`, `bedtime.py`. `idle_detector.py` is **macOS-only** (`ioreg` HIDIdleTime 30 min, `pmset` 5 min) despite the README claiming Linux support. |
| **AAAK "30× lossless" compaction** | **Present** | `aaak.py` exists — the same compaction the MEMPALACE-PARITY audit found to be independently lossy. Worth not chasing. |
| **Benchmarks (LongMemEval-S)** | **Honest-looking** | `BENCHMARKS.md`: matched-embedder **R@5 0.966 = mempalace** (a tie); product embedder bge-small-en-v1.5 R@5 0.962 ("2-in-500, within noise"). States no test-set tuning, 3 seeds. Also self-reports a regression: historical-verbatim retrieval 0.90 → 0.71, and missing its <100 ms@10k latency target (368 ms). |

**Architectural read:** iai-pme is a genuinely sophisticated, hippocampus-inspired
system (pattern separation, time cells, spatial tagger, Hebbian structure,
rich-club, DMN reflection, reconsolidation). It is also **large and single-user**
— ~90 modules is a big maintenance/cold-start surface, and much of it is
macOS-tuned. cortexmd's relative edge is **leanness, transparency, and breadth**.

---

## Where cortexmd already leads

| Capability | cortexmd | iai-pme |
|---|---|---|
| **Code navigation** (symbol search, call graph, change-impact, dead code, semantic dup) | ✅ Rust indexer + `code-nav` | ❌ none |
| **Web dashboard** (overview / vault / intelligence / graph / sessions) | ✅ | ❌ CLI-only |
| **Graph UI & traversal** (`graph_neighbors`/`traverse`/`bridges`/`orphans`) | ✅ | internal graph, no UI |
| **Multi-agent / teams** (agents, diaries, dispatch, shared memory) | ✅ | ❌ single-user |
| **Deployment modes** | local-stdio **and** HTTP (OAuth2/API-key) | local-stdio only |
| **Remote source transports** (git / WebDAV / S3, `IVault`) | ✅ | ❌ engine-local only |
| **Open, inspectable store** (Markdown + wikilinks + frontmatter) | ✅ no lock-in | ❌ opaque encrypted DB |
| **Cross-platform** | Linux/macOS/Windows | macOS-leaning (idle detector macOS-only; Windows "coming soon") |
| **Multilingual potential** | swappable `EMBEDDING_MODEL` | ❌ English-only by design |
| **Lean footprint / fast cold start** | ✅ | ❌ ~90 modules, "warm-up ~10 sessions" |

---

## Real gaps (cortexmd is behind or lacks the capability)

| # | Gap | iai-pme (verified) | cortexmd today | Effort | Deliberate non-goal? |
|---|-----|--------------------|----------------|--------|----------------------|
| 1 | **Multi-signal recall fusion (incl. centrality + temporal validity)** | Recall fuses `0.6*cos + 0.4*centrality`, temporal `valid_from/to` from contradiction edges, and ×0.5 stale downweight — all in the hot path. | `search.ts` fuses **only lexical + semantic** via RRF (+ collection boost, optional reranker). Heat/recency, graph centrality, and KG invalidation live in *separate* layers, not the query-time ranker. | **M** | No — highest-leverage win; the inputs already exist. |
| 2 | **Contradiction-aware recall (Rescue@10)** | Contradiction edges + temporal validity + stale downweight + reconsolidation keep the *current* fact ranked top-10 after it's superseded. | `kg_invalidate` marks KG facts stale, but invalidation does **not** down-rank superseded notes at Markdown-recall time. | **M** | No — directly copyable mechanism. |
| 3 | **Encryption at rest** | AES-256-GCM, per-record nonce, PBKDF2-600k or 0600 keyfile. | Plaintext Markdown by design. No at-rest confidentiality. | **M** | Partly — openness is the thesis, but an **opt-in encrypted brain-vault** backend closes a real threat-model gap without changing the default. |
| 4 | **Graph community detection for clustering** | Leiden/CPM (`mosaic.py`) with auto gamma tuning + community lineage, used for coherent episode replay. | Dream clustering is shared-**tag** union-find + tag-pair co-occurrence — far cruder. | **M** | No — Leiden/Louvain over the existing link graph would materially improve theme/consolidation quality. |
| 5 | **Hyperdimensional / structural recall** | Real VSA substrate (BSC/FHRR/sparse) with binding/bundling and sleep replay; retrieval by hypervector geometry. | Dense embeddings (HNSW) + lexical only. No VSA/HDC. | **L** (research) | No, but **lowest ROI** — the measurable wins (Rescue@10, R@k tie) come from gaps #1–#2, not HD. Treat as a research spike, not a priority. |
| 6 | **Published, reproducible benchmarks** | LongMemEval-S R@5 0.966 (tie w/ mempalace), Rescue@10 1.000, drift 0.9933, latency/RSS @10k — with harnesses and stated caveats. | `lib/benchmark.ts` + `benchmark_run` exist but results are **unpublished** (also MEMPALACE-PARITY #4). | **M** | No — pure credibility upside; harness already exists. |
| 7 | **Verbatim write-once episodic tier** | Episodes "write-once, never overwritten"; consolidation produces *derived* notes. | Auto-consolidation **merges + deletes** originals. `isProtectedFromConsolidation` guards some classes, but unique cold notes can still be folded away. | **S** | Partly — an immutable episodic tier (consolidation only *derives*, never destroys source) is safer and matches the lossless stance. |
| 8 | **Idle-edge / sleep-driven consolidation** | FSM (`lifecycle_state`/`daemon_state`/`sleep`/`bedtime`) drains the capture buffer on an idle edge; offline-friendly. | Dream cycle is **cron-scheduled** (`DREAM_SCHEDULE`) or manual; no idle trigger. | **M** | No — an activity/idle trigger consolidates more promptly. (Build it cross-platform; iai's detector is macOS-only.) |
| 9 | **Zero-RPC in-session capture** _(claimed)_ | Turn capture is pure file IO; heavy work deferred to the idle drain. | Recall/capture hooks call back into the MCP server during the session. | **S** | Maybe — a pure-append buffer drained later would cut per-turn latency. |
| 10 | **Self-tuning procedural profile** | _Partial in iai too_ — `user_model.py` aggregates topics/tools/timing + surprise boost; the "knobs" are placeholders. | `preference-detector` + `fact`/`preference` categories; no adaptive profile. | **M** | No — but iai isn't actually ahead here; a bounded self-tuning profile is greenfield for both. |
| 11 | **Single-binary install / footprint profile** | One local engine; concrete resource envelope. | Needs Node build **+** Rust `cargo build`; no published footprint (MEMPALACE-PARITY #1). | **L** | No — biggest adoption blocker; ship a prebuilt bundled distribution. |

---

## Notable differences that are *not* gaps (deliberate divergence)

- **Opaque encrypted DB vs. open Markdown vault** — confidentiality vs.
  inspectability. Both valid; see gap #3 for the opt-in middle path.
- **English-only (bge-small-en, hardcoded `"autistic"` mode) vs. swappable
  `EMBEDDING_MODEL`** — cortexmd advantage for multilingual vaults.
- **Single-user vs. multi-agent/HTTP** — teams/agents/remote are out of
  iai-pme's scope entirely.
- **~90-module neuroscience engine vs. lean two-toolchain design** — iai's depth
  is real but costly to maintain and cold-start; cortexmd's leanness is a feature.
- **Don't chase AAAK** — `aaak.py` is the same "30× lossless" compaction the
  MEMPALACE audit found to be lossy. Offer only *measured, opt-in* compaction.

---

## Prioritised roadmap (highest leverage first)

1. **Fold recency + graph centrality + KG invalidation into the recall ranker**
   (gaps #1 + #2, **M**). cortexmd already computes heat, the link graph, and
   `kg_invalidate`; wiring them into `search.ts` ranking (plus a stale-downweight
   for superseded notes) is mostly plumbing and is the single biggest quality
   win — and the path to a Rescue@10-style result without new ML.
2. **Publish honest benchmarks** (gap #6, **M**). Harness exists. State the
   embedding model; separate retrieval-recall from end-to-end QA; **include a
   contradiction/Rescue@10 test** so #1–#2 are measured, not asserted.
3. **Immutable episodic tier + Leiden consolidation** (gaps #7 + #4, **S+M**).
   Consolidation emits *derived* semantic notes linking back to never-deleted
   episodes; cluster via community detection over the link graph, not tag
   union-find.
4. **Opt-in encrypted brain-vault backend** (gap #3, **M**). An encrypted
   `IVault` write impl behind a flag; plaintext stays the default.
5. **Cross-platform idle-edge dream trigger + zero-RPC session buffer**
   (gaps #8 + #9, **M+S**).
6. **Bounded self-tuning profile** (gap #10) and **single-binary distribution**
   (gap #11, **L**) — larger bets, after the above. **HD/VSA recall (gap #5)**
   stays a research spike, not a priority.

## Status

- [x] Recency + centrality + co-recall fused into recall ranking (gaps #1, #2) — shipped
- [x] Contradiction-aware staleness (Rescue@10 mechanism) — shipped, **via Bayesian validity** (see re-audit below), not `superseded` frontmatter
- [~] Benchmark **harness** done (`computeRescueAtK`, R@5/10, NDCG, p50/p95, `benchmark_run`); **publication still open** — no `BENCHMARKS.md`, results unrendered on dashboard (gap #6)
- [x] Immutable episodic tier; consolidation never deletes source (gap #7) — shipped: `applyAutoConsolidation` archives sources (`consolidated_into`+`archived`) instead of deleting
- [x] Community-detection clustering in the dream cycle (gap #4) — shipped: Louvain (`lib/community.ts`) over a tag-co-occurrence graph replaces tag union-find
- [ ] Opt-in encrypted brain-vault backend (gap #3)
- [ ] Cross-platform idle-edge consolidation trigger + zero-RPC buffer (gaps #8, #9)
- [ ] Bounded self-tuning procedural profile (gap #10)
- [ ] Single-binary distribution (gap #11)
- [ ] HD/VSA structural-recall research spike (gap #5) — low priority

---

## Re-audit — 2026-06-25 (grounded in shipped source)

A source-level re-audit after the recall-fusion, co-recall, and benchmark work
landed (commits `58b827c`, `bd5a916`, plus `51300f4`). The original gap table
above is preserved as the historical baseline; this section is the current
truth.

### What shipped (gaps now closed)

- **#1 Multi-signal fusion — DONE.** `lib/recall-signals.ts` (centrality,
  log-saturated at 25) + `tools/memory-recall.ts` fuse centrality, heat
  (heat_score→0.5..1.5), category-specific recency half-lives, Bayesian validity,
  related, and co-recall — multiplicatively, in the hot path. Weights are
  config-driven (`RECALL_CENTRALITY_WEIGHT=0.15`, `CO_RECALL_WEIGHT=0.2`).
- **#2 Contradiction-aware Rescue@10 — DONE, but a different mechanism than this
  doc proposed.** We did **not** add `superseded`/`valid_to` frontmatter. Instead
  recall uses a **Bayesian Beta(α,β) validity posterior** (`memory.ts`
  `computeValidity`): `detectMemoryConflicts` flags a conflict at cosine ≥0.80 +
  Jaccard <0.5 over the shared entity; `memory_store` then bumps the **older**
  note's β (`updateValidity(path,'failure')`) and stamps `contradicts:[…]` on the
  new note. At recall, validity ≤0.40 → **quarantined (excluded)**; 0.40–0.60 →
  **stale (×0.5)**; successful recalls bump α. This is the Rescue@10 mechanism,
  self-correcting rather than schema-stamped — **update copies of the plan that
  still describe `superseded` frontmatter.**
- **Bonus — Hebbian co-recall (not in the original gap list).** `lib/co-recall.ts`
  is an undirected association graph (0.98^days decay, 32-neighbour cap, symmetric
  pruning, atomic persist + flush-on-shutdown) that boosts associates of the
  top-5 seeds. This is closer to iai's associative/spreading recall than anything
  in the original plan.

### Still open (re-sequenced by leverage)

1. **#6 — Publish benchmarks (now mostly a writing+wiring task).** Harness +
   `computeRescueAtK` (`benchmark.ts:417`) + `benchmark_run` exist;
   `benchmarkSummary` already sits in the dashboard payload (`payload.ts:94`) but
   is **not rendered**. Remaining: run it on a committed fixture set, write
   `docs/BENCHMARKS.md`, and surface a benchmark panel on the Intelligence tab.
   Lowest effort, highest credibility — and it doubles as the dashboard win.
2. ~~**#7 + #4 — Immutable episodic tier + Louvain.**~~ **DONE.**
   `applyAutoConsolidation` now stamps `consolidated_into`+`archived` on each
   source instead of deleting it (immutable episodes; the safety fix re: the
   recorded dream-deletes-real-notes incidents), and `findConsolidationCandidates`
   clusters via Louvain (`lib/community.ts`) over a mega-tag-capped
   tag-co-occurrence graph instead of shared-tag union-find.
3. **#3 encrypted backend, #8/#9 idle-edge + zero-RPC, #11 single-binary** —
   now the next open work. **#5 HD/VSA** stays a research spike.
