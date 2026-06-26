# Implementation plan — closing the iai-pme gaps

Companion to [`GAPS-IAI-PME.md`](./GAPS-IAI-PME.md). That doc says *what* is
missing and *why*; this one says *what to add* and *how*, grounded in the actual
cortexmd source. Phases are ordered by leverage-per-effort. Each phase is
independently shippable and gated by the benchmark harness from Phase 2.

> **Guiding constraint.** Every change is **additive and default-off or
> default-equivalent** until the benchmark proves a non-regression. The
> open-Markdown-vault thesis is preserved (encryption stays opt-in).

> **⚠️ STATUS UPDATE (2026-06-25).** Phases 1 and the Phase-2 *harness* have
> **shipped** — but Phase 1 took a different route than written below. Recall now
> fuses centrality/heat/recency/co-recall (`lib/recall-signals.ts`,
> `lib/co-recall.ts`) and the Rescue@10 mechanism is a **Bayesian Beta(α,β)
> validity posterior** (`memory.ts` `computeValidity` + `detectMemoryConflicts`),
> **not** the `superseded`/`valid_to` frontmatter scheme in Phase 1b below. Treat
> Phase 1 as DONE-by-other-means; Phase 1b's frontmatter design is superseded by
> the validity-posterior implementation. The **live next PR is Phase 2's
> *publication* + Phase 3** (see the re-audit in `GAPS-IAI-PME.md`). The Phase
> 1/1a/1b text is kept below for historical context only.

---

## Phase 1 — Multi-signal, contradiction-aware recall ranking  *(gaps #1, #2)*

**The single highest-leverage change.** Today `hybridSearch` in
`packages/server/src/lib/search.ts` fuses **only** lexical + semantic via RRF,
then applies a collection-weight boost (lines ~554–620). Heat, recency, graph
centrality, and KG invalidation already exist in the codebase but never touch
the recall ranking. iai-pme's measurable wins (R@k tie, **Rescue@10 = 1.000**)
come exactly from folding these in (`0.6*cos + 0.4*centrality`, temporal
validity, ×0.5 stale downweight) — not from HD.

### 1a. Add the signals to the ranker

In `search.ts`, replace the single `collectionBoost` multiply with a small
composable scorer applied at the existing fusion loop (the
`boostedScore` computation, ~line 603):

```ts
// new: lib/recall-rank.ts
export interface RankSignals {
  rrf: number;          // lexical+semantic RRF (existing)
  collectionBoost: number;
  heatScore?: number;   // meta.heat_score (already in DocMeta)
  lastAccessed?: string;
  inboundLinks?: number; // from graph.getInboundLinkCounts()
  superseded?: boolean;  // new frontmatter (see 1b)
  validTo?: string;      // new frontmatter (see 1b)
}

// weights are config-driven (config.recallWeights) and default to
// { recency: 0, centrality: 0, heat: 0, stale: 1 } so the ranking is
// byte-for-byte unchanged until a weight is turned on + benchmarked.
export function rankScore(s: RankSignals, now = Date.now()): number {
  let score = s.rrf * s.collectionBoost;
  score *= 1 + w.heat * normHeat(s.heatScore);
  score *= 1 + w.centrality * normLog(s.inboundLinks);   // degree centrality
  score *= 1 + w.recency * recencyDecay(s.lastAccessed, now); // exp(-Δdays/τ)
  if (isStale(s, now)) score *= w.staleFactor;            // default 0.5
  return score;
}
```

- **Centrality** is the cheap, already-available proxy: `getInboundLinkCounts()`
  in `graph.ts:377` gives degree. (Eigenvector/PageRank centrality is a later
  refinement; degree is enough to match iai's `0.4*centrality` term.)
- **Recency / heat** read straight off `DocMeta` (`heat_score`, `last_accessed`
  already present, lines 41–50 of `search.ts`).
- Wire `getInboundLinkCounts()` into `hybridSearch` once per query (it's cached
  in `graph.ts`), not per result.

### 1b. Contradiction-aware staleness (the Rescue@10 mechanism)

cortexmd has `kgInvalidateTriple` (`knowledge-graph.ts:124`) but it only marks
**KG triples** stale, never down-ranks the **Markdown note** that carried the
superseded fact. Bridge that:

1. **Frontmatter**: add `superseded: true` and `valid_to: <date>` (and the
   inverse `supersedes: [[old]]`) to the note schema. Surface both in `DocMeta`
   (extend the interface + the frontmatter read in `search.ts` indexing).
2. **Write path**: when `memory_store` / `kg_add` detects a contradiction
   (there's already contradiction handling in `memory.ts` — see the
   `invalidate|supersede|contradict` matches), stamp the **older** note's
   frontmatter with `superseded: true`, `valid_to: today`, and a
   `superseded_by` backlink. This is a sole-writer brain-vault op, so it's safe.
3. **Read path**: `isStale()` in `rankScore` returns true when `superseded` or
   `valid_to < now` → ×0.5. The superseded note still appears (verbatim history
   preserved) but the current fact wins — exactly Rescue@10.

### 1c. Config + safety
- `config.ts`: add `recallWeights` (env `RECALL_*`) with the no-op defaults above.
- Keep the optional reranker pass (lines 622–638) as the final stage.
- **Acceptance:** Phase 2 benchmark shows R@k non-regression with recency/heat/
  centrality on, **and** a new Rescue@10 test goes from ~0.7 → ≥0.95.

**Effort: M.** Touches `search.ts`, new `recall-rank.ts`, `config.ts`,
`memory.ts` (stamp on contradiction), `DocMeta`/frontmatter schema.

---

## Phase 2 — Benchmark harness + published results  *(gap #6)*

Gate for every other phase. `lib/benchmark.ts` + the `benchmark_run` tool
already exist (default queries, `recall_any@k` shape); extend, don't rebuild.

1. **Datasets**: add a small committed fixture set (synthetic + a LongMemEval-S
   subset loader) so results are reproducible without shipping the full corpus.
2. **Metrics**: implement `recall_any@k` (k=5,10) and a **Rescue@10** scenario
   generator — store fact A, store contradicting fact A′, assert A′ ranks
   top-10 and A is down-ranked. Add latency (p50/p95) and indexed-note count.
3. **Honest methodology doc**: `docs/BENCHMARKS.md` — state the embedding model
   (`Xenova/all-MiniLM-L6-v2`, swappable), separate **retrieval recall** from
   end-to-end QA, multi-seed, no test-set tuning. Mirror iai's transparency
   (they even publish their regressions).

**Effort: M.** Mostly `benchmark.ts` + a new `BENCHMARKS.md`.

---

## Phase 3 — Immutable episodic tier + Leiden/Louvain consolidation  *(gaps #7, #4)*

### 3a. Stop deleting source on consolidation
`applyAutoConsolidation` (`memory-lifecycle.ts:308`) currently writes a summary
then **deletes** the originals. Change to the iai "write-once episode" model:
- Write the **derived** summary note (as today).
- Instead of `deleteNote`, stamp each source with `consolidated_into: <summary>`
  + `archived: true` (the archival gate already recognises `consolidated_into`
  at line ~679). Originals stay on disk, linked, never destroyed.
- Same for `project-reconcile.ts` `reconcileClusterIntoProject`.

### 3b. Community detection instead of tag union-find
`findConsolidationCandidates` (`memory-lifecycle.ts:202`) and
`clusterColdNotes` cluster by **shared-tag union-find** — crude vs. iai's
Leiden/CPM (`mosaic.py`). Add `lib/community.ts`:
- Implement **Louvain** (simpler, MIT-clean, no numba needed) over the existing
  link graph from `graph.ts` (`buildLinkGraph` adjacency + tag-similarity edges
  as a fallback weight).
- Return communities → feed them as consolidation/reconciliation clusters.
- Louvain first; Leiden refinement (CPM, resolution tuning) is a later upgrade
  if benchmarks justify it.

**Effort: S (3a) + M (3b).**

---

## Phase 4 — Opt-in encrypted brain-vault backend  *(gap #3)*

Preserve the open-vault default; add confidentiality for users who need it.
The `IVault` seam (`docs/transports.md`, `lib/vault/registry.ts`) already
abstracts byte access — add an encrypting implementation:

- `lib/vault/encrypted-local-vault.ts`: wraps `LocalVault`; on write, AES-256-GCM
  encrypt (Node `crypto.createCipheriv('aes-256-gcm')`), `iai`-style payload
  (version prefix + nonce + ciphertext + tag); on read, decrypt.
- **Key**: `BRAIN_VAULT_KEY_FILE` (0600, uid-checked) **or**
  `BRAIN_VAULT_PASSPHRASE` → PBKDF2-HMAC-SHA256 (≥600k iters), mirroring
  iai's `crypto.py`.
- `config.ts`: `BRAIN_VAULT_ENCRYPT=false` default. When on, the dashboard +
  Obsidian-openness are knowingly traded away (document the tradeoff).
- Only the **brain vault** write impl encrypts; source vaults stay read-only
  plaintext.

**Effort: M.** Self-contained behind the seam.

---

## Phase 5 — Cross-platform idle-edge consolidation + zero-RPC capture  *(gaps #8, #9)*

### 5a. Idle-triggered dream
Today the dream is cron-only (`DREAM_SCHEDULE` via `scheduler.ts`). Add an
activity-driven trigger that works on Linux/macOS/Windows (iai's detector is
macOS-only `ioreg`/`pmset` — we can do better):
- Track `lastActivityAt` updated on every tool call in `tool-wrapper.ts`.
- `scheduler.ts`: register an interval job (e.g. every 60s) that fires a
  **lightweight** dream pass when `now - lastActivityAt > IDLE_MS` (default
  5 min) and a dream hasn't run since the last activity burst. Debounce so it
  fires once per idle edge, not repeatedly.

### 5b. Zero-RPC in-session capture
iai's turn capture is pure file IO, drained on idle. Mirror it:
- The capture hook appends `{prompt, prevAssistantTurn}` to a per-session
  append-only buffer file (no MCP RPC during the session).
- The idle-edge job (5a) drains the buffer through the normal
  embed/dedup/store pipeline. Cuts per-turn latency to a file append.

**Effort: M (5a) + S (5b).** Touches `scheduler.ts`, `tool-wrapper.ts`, hooks.

---

## Phase 6 — Later / lower-priority

- **Bounded self-tuning procedural profile (gap #10).** iai's own
  implementation is mostly placeholders, so this is greenfield for both. A
  small, capped profile (top topics, tool-usage freq, time-of-day) updated by
  event aggregation + surprise boost — derived from existing journal/diary
  data; never a hidden mutable knob.
- **Single-binary distribution (gap #11, L).** Bundle the Node server + Rust
  indexer into one artifact / published image so `docker compose up` (or one
  binary) is the whole install. Biggest adoption lever; tracked in
  MEMPALACE-PARITY #1.
- **HD/VSA structural recall (gap #5, research spike).** Only after Phase 1–2
  show fusion has plateaued. Prototype a Binary-Spatter-Code tier behind the
  embeddings seam and benchmark against the dense baseline before committing.

---

## Sequencing & dependencies

```
Phase 2 (benchmark) ──┬──> Phase 1 (recall fusion + Rescue@10)   ← do first two together
                      ├──> Phase 3 (immutable tier + community detection)
                      ├──> Phase 5 (idle trigger + zero-RPC capture)
                      └──> Phase 4 (encrypted backend, independent)
Phase 6 (profile / single-binary / HD) ── after the above
```

**Recommended first PR:** Phase 2 + Phase 1a/1b together — the benchmark proves
the fusion change, and the Rescue@10 test makes the contradiction win visible.

## Checklist

- [x] Phase 1a: heat/recency/centrality + co-recall fused into recall (`lib/recall-signals.ts`, `lib/co-recall.ts`, `tools/memory-recall.ts`, `config.recall*`) — **shipped**
- [x] Phase 1b: contradiction-aware stale downweight — **shipped via Bayesian validity** (`computeValidity`/`detectMemoryConflicts`), *not* the `superseded`/`valid_to` schema below
- [x] Phase 2 (harness): `computeRescueAtK` + R@5/10 + NDCG + p50/p95 in `benchmark.ts`; `benchmark_run` tool — **shipped**
- [ ] Phase 2 (publish): committed fixture set, `docs/BENCHMARKS.md`, render `benchmarkSummary` on the Intelligence dashboard tab — **open, next PR**
- [ ] Phase 3a: consolidation links instead of deletes (immutable episodes) — **open; `applyAutoConsolidation` still deletes originals**
- [ ] Phase 3b: `community.ts` Louvain clustering replaces tag union-find — **open; no `community.ts` yet**
- [ ] Phase 4: `encrypted-local-vault.ts` + key management, default-off
- [ ] Phase 5a: idle-edge dream trigger (cross-platform) in `scheduler.ts`
- [ ] Phase 5b: zero-RPC append-buffer capture drained on idle
- [ ] Phase 6: procedural profile / single-binary dist / HD spike
