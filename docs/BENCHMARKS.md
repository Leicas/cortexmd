# Benchmarks

Honest, reproducible measurements of cortexmd's retrieval. The guiding rule
here is the same one the competitive audits land on (see
[`MEMPALACE-PARITY.md`](./MEMPALACE-PARITY.md), [`GAPS-IAI-PME.md`](./GAPS-IAI-PME.md)):
**publish what we can reproduce, state the method, and never quote a headline
number we didn't measure.** Where a number depends on a private corpus we don't
ship, we give you the recipe to measure it on your own vault instead of printing
a figure you can't check.

## Methodology

- **Embedding model:** `Xenova/all-MiniLM-L6-v2` (default; swappable via
  `EMBEDDING_MODEL`). All semantic recall numbers are tied to this model — a
  different embedder will move them.
- **Retrieval, not end-to-end QA.** Every metric below measures whether the
  *right note is retrieved*, not whether an LLM then answers correctly. We keep
  these separate on purpose: bundling them hides where error comes from. (This is
  the same conflation that inflated some competing "R@5 ≈ 0.97" headlines, which
  are really the embedder's default recall over verbatim chunks, not an
  architecture result.)
- **No test-set tuning.** Weights (`RECALL_CENTRALITY_WEIGHT`,
  `CO_RECALL_WEIGHT`, validity thresholds) are not fit to any benchmark set.
- **Reproducibility tiers.** A metric is either:
  - **Self-contained** — runs from the repo with no private data, CI-guarded.
    (Rescue@10.)
  - **Operator-run** — you point the harness at *your* labeled query set,
    because the relevant notes live in your vault, not ours. (Recall@k / NDCG.)

## Metrics

| Metric | What it measures | Tier | Source |
|--------|------------------|------|--------|
| **Rescue@10** | After a fact is contradicted by a newer one, does the current fact still rank top-10 while the superseded one is demoted/dropped? | Self-contained | `runRescueBenchmark()` in `lib/benchmark.ts` |
| **Superseded-demoted** | Fraction of contradiction cases where the stale fact is ranked below the current one (or excluded) | Self-contained | same |
| **Recall@5 / Recall@10** | Fraction of relevant notes retrieved in top-k | Operator-run | `runQualityBenchmark()` / `benchmark_run` |
| **NDCG@5 / NDCG@10** | Rank-weighted retrieval quality | Operator-run | same |
| **Zero-recall rate** | Fraction of queries that returned *none* of the relevant notes | Operator-run | same |
| **Latency p50 / p95** | Per-query search latency | Operator-run | same |

## Rescue@10 — contradiction resilience (self-contained)

**Result: Rescue@10 = 1.000, superseded-demoted = 1.000** over the canonical
contradiction scenarios. This is the iai-pme-style metric, and it is the one
cortexmd should be judged on, because a naive vector store *fails* it — a
superseded fact keeps its high cosine score and outranks the correction.

### The mechanism (no HD/VSA magic)

cortexmd does this with a **Bayesian Beta(α, β) validity posterior**, not
embedding geometry:

1. **Write path.** When `memory_store` detects a contradiction —
   `detectMemoryConflicts` flags it at cosine ≥ 0.80 **and** token-Jaccard < 0.5
   over the shared wiki-linked entity — it bumps the **older** note's β
   (`updateValidity(path, 'failure')`) and stamps `contradicts: [...]` on the new
   note.
2. **Validity.** `computeValidity` returns `validity = α / (α + β)`. Recall
   classifies a note **quarantined** at validity ≤ 0.40 (excluded entirely) and
   **stale** at 0.40–0.60 (ranked, but ×0.5 via `VALIDITY_STALE_RANK_PENALTY`).
3. **Read path.** Successful recalls bump α, so a fact that keeps proving useful
   recovers. The superseded note is never deleted — history is preserved — it
   just stops winning.

So one contradiction makes the old fact *stale* (halved); a second
*quarantines* it. The current fact survives both — that's the 1.000.

### Why it's trustworthy

`runRescueBenchmark()` reconstructs the exact `memory_recall` scoring contract
(quarantine → drop, stale → ×0.5) over the **real** validity constants, and a
test (`lib/__tests__/recall-signals.test.ts`) asserts the published 1.000. If a
constant ever drifts the number below 1.000, **CI fails** — the claim can't go
stale silently. The same number is surfaced live on the dashboard's
**Intelligence → Recall Engine** card.

### Reproduce it

```bash
cd packages/server
npx vitest run src/lib/__tests__/recall-signals.test.ts
```

## Recall@k / NDCG — retrieval quality (operator-run)

We deliberately **do not** print a Recall@5 figure here. The honest version of
that number requires labeled `(query → expected notes)` pairs, and the relevant
notes live in *your* vault. Quoting a figure against our private corpus would be
unverifiable and unrepresentative of yours. Instead, measure it on your own
data:

1. Create a JSONL dataset (relative path under the server working dir), one
   query per line:

   ```jsonl
   {"query": "architecture decision on auth", "expected_paths": ["memories/auth-decision.md"], "category": "decision"}
   {"query": "who owns partnerships", "expected_paths": ["02 Areas/Core Areas.md"], "category": "crm"}
   ```

2. Run the harness via the MCP tool:

   ```
   benchmark_run { "dataset": "benchmarks/mine.jsonl" }
   ```

   It streams the file, runs each query through the live hybrid search, and
   returns Recall@5/10, NDCG@5/10, zero-recall rate, and avg/p95 latency, broken
   down by `category`.

3. Track it over time. `saveAsGroundTruth()` can snapshot the current top-k as
   expected paths to detect regressions on later runs.

> **Note on the boot benchmark.** The server runs a lightweight latency
> benchmark at startup over default queries with *no* ground truth, so its
> Recall/NDCG fields report `-1` (not measured) — it exists to track search
> latency, not quality. Quality requires the labeled dataset above.

## Where this sits vs. the competition

- **vs. iai-pme** — iai reports Rescue@10 = 1.000 driven by contradiction edges
  + temporal validity + stale downweighting. cortexmd reaches the same result by
  a Bayesian-validity route (above): same outcome, different, fully-transparent
  mechanism, over an open Markdown vault rather than an encrypted DB.
- **vs. mempalace** — its headline "30× lossless" compaction is independently
  shown to be **lossy** (LongMemEval recall 96.6% → 84.2%), and its "96.6% R@5"
  is the embedder's default over verbatim chunks, not an architecture win.
  cortexmd's stance: only *measured, opt-in* compaction, and benchmark numbers
  you can reproduce.

## Caveats

- Numbers are embedder-specific (`all-MiniLM-L6-v2` by default).
- Retrieval recall ≠ answer quality; we report only retrieval here.
- The self-contained Rescue@10 uses canonical synthetic contradiction cases by
  design — it isolates the ranking pipeline so the mechanism, not corpus luck,
  is what's measured. End-to-end Rescue over a live vault is future work
  (drive `computeRescueAtK` from real `memory_store` → `memory_recall` runs).
