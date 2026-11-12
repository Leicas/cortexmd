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
3. **Read path.** Recall filters or down-ranks low-validity notes. Displaying a
   result does not bump α: retrieval alone cannot confirm that a claim is true.
   A superseded note remains available as historical evidence.

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

   It streams the file, runs each query through the real `memory_recall` path
   (limit 10, post-fusion priors and MMR included, no access-count bumps), and
   returns Recall@5/10, NDCG@5/10, MRR, top-1, zero-recall rate, and avg/p95
   latency, broken down by `category` (`mode: "memory_recall"` in the output).
   Note that `memory_recall` only returns `type: memory` notes, so gold paths
   outside that scope can never be hit.

3. Track it over time. `saveAsGroundTruth()` can snapshot the current top-k as
   expected paths to detect regressions on later runs.

> **Note on the boot benchmark.** The server runs a lightweight latency
> benchmark at startup over default queries with *no* ground truth, so its
> Recall/NDCG fields report `-1` (not measured) — it exists to track search
> latency, not quality. Quality requires the labeled dataset above.

### Recall eval CLI — regression gate for ranking changes

`npm run eval:recall` (in `packages/server`) runs a labeled dataset through
**exactly the `memory_recall` tool path** (`runMemoryRecall` in
`src/tools/memory-recall.ts`, limit 10) against a vault directory, prints a
per-category table and writes full JSON (per-query ranked paths and gold ranks)
to `.realvault-eval/results/<label>.json`. Both `.realvault-snapshot/` and
`.realvault-eval/` are gitignored: real queries and paths never get committed.

```bash
# smoke (~15 s once caches are warm; first run builds embeddings, ~2-3 min): 40 queries
npm run eval:recall -- --limit 40 --label smoke
# full run (~1.5 min for ~260 queries x 4 arms), gated against a saved baseline
npm run eval:recall -- --arms recall,noprior,lexical,semantic --label my-change \
  --compare .realvault-eval/results/baseline.json
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--vault` | `.realvault-snapshot` | vault dir (read-only; see `npm run snapshot`) |
| `--dataset` | `.realvault-eval/queries/` | a `*.jsonl` file or a dir of them |
| `--label` | `run-<timestamp>` | results file name |
| `--arms` | `recall` | `recall` (real tool path), `noprior` (same path, every prior multiplier = 1), `lexical` (raw `hybridSearch`, no vectors), `semantic` (raw `hybridSearch` with vectors) |
| `--embeddings` | `on` | `off` for lexical-only; the model + HNSW index are cached in the data dir, first build of ~10k notes takes minutes on CPU |
| `--limit N` | all | deterministic subsample, stratified by category (hash of `id`) |
| `--compare F` | – | exit 1 if Recall@5 or MRR drops > 2 pt in any category with ≥ 10 scored queries, or p95 latency regresses > 50 % (and > 20 ms); computed on the query ids common to both runs |
| `--noise-prefixes` | `Memories/consolidated/,EmailLog/` | path prefixes counted as top-5 noise |
| `--raw-scope` | `memory` | candidate pool of the raw arms (`all` = whole vault) |
| `--data-dir` | `.realvault-eval/data/<vault name>` | persistent index/embedding cache |

Dataset schema, one JSON object per line (`#`/`//` lines ignored):

```jsonl
{"id": "q-001", "query": "which database did we pick", "expected_paths": ["Memories/decision/db.md"], "category": "factual", "lang": "en", "source": "authored", "notes": "optional"}
{"id": "neg-001", "query": "something the vault never covered", "expected_paths": [], "category": "negative"}
```

Gold paths are vault-relative and matched case-, `.md`- and slash-insensitively.
Paths missing from the vault are warned about and dropped (a row left with no
gold is "unscorable"); gold notes that are not `type: memory` are reported as
outside `memory_recall`'s scope. Metrics: Recall@5/10, MRR (over the ≤ 10
returned), nDCG@10, top-1, negative abstention (share of `negative` queries
returning nothing), noise-in-top-5 (share of returned top-5 slots under the
noise prefixes, non-negative queries), p50/p95 latency, mean rendered response
size. Runs are side-effect free: `RECALL_NO_TOUCH=1` / `touch:false` disables
access bumps and co-recall recording, and the CLI fails (exit 3) if any file in
the vault changed during the run. A synthetic fixture
(`src/eval/fixtures/recall-vault/`, `recall-queries.jsonl`) backs the unit test
`src/eval/__tests__/recall-eval.test.ts`.

### Embedding models, chunking and the local cross-encoder

`npx tsx src/eval/semantic-eval.ts --data-dir <dir> --arms vector,noprior30,rerank`
(in `packages/server`) isolates what the recall arms cannot: `vector` ranks by
the vector index alone (no lexical arm, no fusion), `rerank` re-orders the
top-30 of the `noprior` arm with `lib/cross-encoder.ts` (passage = title +
the note's best-matching chunk) and reports the added latency. Configure with
the normal env (`EMBEDDING_MODEL`, `EMBEDDING_CHUNKING`, `--reranker`), one
`--data-dir` per configuration. What it decided on a 9.6k-note bilingual
(EN/FR) vault, 242 scored queries, CPU only:

- **Chunk-level vectors (default on).** Vector-only Recall@5 72.0 → 77.0 %,
  MRR 0.663 → 0.710; on queries whose answer sits past the first ~1,000 chars,
  top-1 12.5 → 43.8 %. Through hybrid search the gain is smaller (MRR
  0.825 → 0.832, no category regresses). Cost: 2.4× vectors, index 16 → 40 MB,
  ~2 ms per query. Best-chunk (`max`) roll-up beat the mean of the two best.
- **`Xenova/multilingual-e5-small` (opt-in).** Vector-only Recall@5 79.1 % and
  French-query → English-note Recall@5 20 → 67 % without chunking; hybrid
  Recall@5 +1 pt with MRR flat once the semantic floor matches the model's
  cosine range (preset 0.75). About half the embedding throughput of MiniLM
  and a 130 MB download, so it stays opt-in.
  `Xenova/paraphrase-multilingual-MiniLM-L12-v2` was far worse on this task
  (vector-only Recall@5 27 %); `onnx-community/embeddinggemma-300m-ONNX` (q8)
  ran at ~2 chunks/s and ~330 ms per query on CPU — too slow to evaluate.
- **Local cross-encoder (off).** `Xenova/ms-marco-MiniLM-L-6-v2` over the
  top-30 lowered Recall@5 by 3.6 pt and MRR by 0.03 (cross-lingual queries
  hardest hit) for >1 s added per query: not wired into recall.

### Recall ranking — what the eval decided

How `memory_recall` ranks, and the switch that restores each previous
behaviour. Every default below was chosen on the real-vault eval (262 queries,
9,648 notes, MiniLM embeddings); numbers are the `recall` arm.

| Stage | Default | Legacy switch |
|-------|---------|---------------|
| Lexical analyzer | accent folding, EN+FR stopwords, light plural stemming, fuzzy only from 5 chars, prefix from 3 | `LEXICAL_ANALYZER=legacy` |
| Semantic candidates | kNN k = 200, scope-filtered **before** ranking | `SEMANTIC_CANDIDATES` |
| Fusion | weighted normalised scores: 0.5 · BM25/bestBM25 + 0.5 · (cos − 0.15)/0.85 | `HYBRID_FUSION=rrf` |
| Re-scoring | relevance × (1 + prior), prior clamped to ±0.08; explicit intent (relatedTo ×1.5, context ≤ ×1.25, stale ×0.5, archived ×0.35) unbounded | `RECALL_SCORING=legacy` |
| Memory kinds / low-priority tier | every note is classified episodic / semantic / procedural (`lib/memory-kind.ts`). Semantic + procedural rank first; episodic notes are the low-priority tier: digests and email captures ×0.5 unless the query asks for them, other episodic notes ×1 (`RECALL_EPISODIC_PENALTY`). `kinds` / `includeEpisodic` on the tool make the scope strict or lift the demotion | `RECALL_LOW_TIER_PENALTY=1`; `RECALL_EPISODIC=exclude` drops episodic by default (−2.7 pt R@5, −10 pt on temporal queries) |
| Time-aware queries | "last week", "en octobre", "as of March" → inclusive date filter (±1 day slack, UTC vs local), searched on the stripped query; "latest" → recency tie-breaker (±0.06); a parsed period with no match is dropped once and the response says so | `RECALL_TIME_QUERY=off`, `RECALL_TIME_SLACK_DAYS` |
| Diversity | MMR λ = 0.85 | `RECALL_MMR_LAMBDA` |
| Abstention | nothing returned when best BM25 ÷ query IDF mass < 2.5 **and** best cosine < 0.55; flagged "low confidence" below 6 | `RECALL_MIN_EVIDENCE=off` |
| Scope | `durable`: `type: memory` plus non-memory notes of semantic / procedural kind ×0.8; structural notes (index, task, template, code) and non-memory episodic notes (diary days, EmailLog, email digests) are filtered **before** ranking | `RECALL_SCOPE=memory` |
| Graph arm | off; when on, seeded from the fused top-5 and credited to non-seed notes only, weight 0.1 | `PPR_RECALL=true`, `PPR_WEIGHT` |

Measured effect, cumulative (Recall@5 / MRR / top-1 / noise-in-top-5 /
negative abstention / p50 latency):

| Step | R@5 | MRR | top-1 | noise | neg. abst. | p50 |
|------|-----|-----|-------|-------|------------|-----|
| baseline (RRF, unbounded priors, kNN 2×limit) | 35.5 % | 0.290 | 18.2 % | 22.1 % | 0 % | 68 ms |
| + kNN depth, filter before rank | 31.6 % | 0.258 | 15.3 % | 18.8 % | 0 % | 150 ms |
| + bilingual analyzer | 34.6 % | 0.283 | 17.4 % | 15.4 % | 0 % | 19 ms |
| + score fusion (priors still unbounded) | 73.1 % | 0.621 | 49.2 % | 8.9 % | 0 % | 20 ms |
| + bounded priors | 85.7 % | 0.840 | 79.3 % | 3.9 % | 0 % | 21 ms |
| + low-priority tier, evidence floor, MMR 0.85 (**default**) | 86.2 % | 0.841 | 79.3 % | 0.2 % | 35 % | ~25 ms |
| same pipeline, priors neutralised (`noprior` arm) | 86.0 % | 0.831 | 78.1 % | 3.8 % | 0 % | ~25 ms |
| `RECALL_SCOPE=durable` as first shipped (opt-in, no kind filter) | 91.0 % | 0.881 | 82.2 % | 1.9 % | 15 % | ~25 ms |
| + memory kinds as the tier rule (memory scope) | 86.2 % | 0.841 | 79.3 % | 0.2 % | 35 % | ~25 ms |
| + time-aware queries (temporal: 82.5 → 87.5 % R@5) | 86.6 % | 0.843 | 79.3 % | 0.8 % | 35 % | ~25 ms |
| + durable scope by kind, filtered before ranking (**default**) | 91.6 % | 0.884 | 82.6 % | 0.7 % | 35 % | ~25 ms |

Priors are worth about +1 pt MRR as tie-breakers; the same signals applied as
unbounded multipliers cost 50 pt of Recall@5 (and still 13 pt after score
fusion). The `durable` scope finds the gold that lives in project / reference /
CRM notes. Shipped first as an opt-in it returned more digest noise and
abstained less; restricting the added notes to the semantic / procedural kind
and filtering the pool before ranking (so an excluded note no longer sets the
lexical normalisation scale) keeps the gain at the memory scope's noise and
abstention, so it is now the default.

The eval pins "now" to the vault's latest note day (`--now auto`), so
relative-date queries ("last week") stay reproducible on a frozen snapshot.

Abstention trade-off on the 20 negative queries (memory scope; "lost" =
positive queries that returned nothing). The lexical floor was swept with
whole-note embeddings (cosine floor 0.5); with chunk embeddings the best-chunk
cosine runs higher and 0.55–0.6 gives the same split:

| Lexical floor (BM25 ÷ IDF mass) | Negatives abstained | Positives lost |
|---------------------------------|---------------------|----------------|
| 2.0 | 5 / 20 | 1 / 242 |
| **2.5** (default) | 7 / 20 | 2 / 242 (neither had gold in its top 5: Recall@5 unchanged) |
| 4.0 | 7 / 20 | 6 / 242 (−0.9 pt Recall@5) |
| 6.0 (the "low confidence" flag) | 12 / 20 | 11 / 242 |

Four of the negatives are real topics that the snapshot happens not to hold;
they match strongly and are not expected to abstain.

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
