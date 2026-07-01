# Eval fixtures — temporal recall-quality dataset

This directory holds the datasets consumed by the temporal recall-quality eval
harness (`packages/server/src/eval`). Each dataset is a **JSONL file, one
`Scenario` per line**. Blank lines and lines beginning with `#` or `//` are
ignored, so you can annotate a file with comments.

- **`scenarios.jsonl`** — the main dataset (20 scenarios) covering all four
  categories below. This is the file to run for a real measurement.
- **`scenarios.sample.jsonl`** — 3 tiny scenarios used by `--smoke` and the
  unit tests. Keep it small; it is a fast sanity check, not a benchmark.

## Scenario schema

The canonical definition lives in [`../types.ts`](../types.ts); the field names
are load-bearing and must stay exactly as below.

```jsonc
{
  "id": "string",            // stable unique id, shows up in per-scenario report rows
  "description": "string",   // what this scenario tests
  "events": [                // memories ingested in timeline order BEFORE any query
    {
      "ts": "2026-01-10T09:00:00Z", // ISO-8601 — when the fact became true / was recorded
      "content": "markdown body the retriever must surface",
      "tags": ["optional", "tags"]  // optional
    }
  ],
  "queries": [               // point-in-time recall probes, asked "as of" ts
    {
      "ts": "2026-02-01T00:00:00Z", // ISO-8601 instant the query is asked "as of"
      "query": "natural-language recall query",
      "expectContains": ["substr"], // ALL must appear (case-insensitive) in top-k → recall hit
      "expectAbsent": ["stale substr"], // OPTIONAL. Any that leak into top-k count as stale leak.
                                        // Presence of this field marks the query as *temporal*.
      "hops": 1                         // OPTIONAL 1|2 — reasoning hops (advisory, for breakdowns)
    }
  ]
}
```

Scoring semantics (see `../scoring.ts`):

- **recall@k** — a query is a hit when *every* `expectContains` substring appears
  somewhere in the concatenated top-k recalled texts (case-insensitive).
  Measured over **all** queries.
- **pointInTimeAccuracy** — over **temporal** queries only (those with
  `expectAbsent`): the query is correct when it surfaces the valid fact *and*
  leaks no stale fact.
- **staleLeakRate** — over **temporal** queries only: fraction where at least one
  `expectAbsent` substring leaked into the top-k (lower is better).

## Coverage categories

The main dataset intentionally spans four categories. Each is exercised by
several scenarios.

### 1. Single-hop factual recall

One memory holds the answer; recall just has to find it.

```jsonc
{"id":"laptop-model", ...,
 "events":[{"ts":"2026-01-08T14:20:00Z","content":"My primary work laptop is a 16-inch MacBook Pro (M3 Max, 64GB RAM), asset tag LT-4471.", ...}],
 "queries":[{"ts":"2026-04-01T00:00:00Z","query":"what is my work laptop","expectContains":["MacBook Pro","M3 Max"],"hops":1}]}
```

### 2. Multi-hop recall

The answer requires combining two separate memories (`hops: 2`), e.g. person →
project → deadline, or service → owning team → on-call.

```jsonc
{"id":"person-to-project", ...,
 "events":[
   {"ts":"2026-01-05T08:00:00Z","content":"Priya Nair owns the Atlas migration project."},
   {"ts":"2026-01-06T08:00:00Z","content":"The Atlas migration project must be finished before the Q3 board review on 2026-08-15."}],
 "queries":[{"ts":"2026-03-01T00:00:00Z","query":"what deadline is Priya Nair working toward","expectContains":["2026-08-15"],"hops":2}]}
```

### 3. Temporal supersession

A fact changes over time: an event at `t1` sets value A, a later event at `t2`
supersedes it with value B. A query dated **between** `t1` and `t2` expects A
(and forbids B); a query **after** `t2` expects B and lists A under
`expectAbsent` so stale-leak is measured in both directions.

```jsonc
{"id":"pricing-tier-change", ...,
 "events":[
   {"ts":"2026-01-15T00:00:00Z","content":"The Pro plan is priced at $29 per seat per month."},
   {"ts":"2026-04-01T00:00:00Z","content":"Effective April, the Pro plan price increased to $39 per seat per month."}],
 "queries":[
   {"ts":"2026-02-20T00:00:00Z","query":"how much is the Pro plan per seat","expectContains":["$29"],"expectAbsent":["$39"],"hops":1},
   {"ts":"2026-05-01T00:00:00Z","query":"how much is the Pro plan per seat","expectContains":["$39"],"expectAbsent":["$29"],"hops":1}]}
```

Supersession scenarios in the main dataset: `office-move`, `tech-lead-handoff`,
`deploy-target-migration`, `pricing-tier-change`, `ci-provider-swap`,
`standup-time-shift`, `framework-decision-reversed`, `repo-rename`,
`passphrase-rotation`.

### 4. Distractors

Memories that are semantically similar to the answer but must **not** be
surfaced — near-duplicate names, staging-vs-prod config keys, a colleague's
differing preference. The distractor's text is placed in `expectAbsent`.

```jsonc
{"id":"coffee-order-distractor", ...,
 "events":[
   {"ts":"2026-02-05T08:15:00Z","content":"Sarah takes her coffee as an oat-milk flat white, no sugar."},
   {"ts":"2026-02-05T08:16:00Z","content":"Sara (different person, no H) drinks a double espresso, one sugar."}],
 "queries":[{"ts":"2026-06-01T00:00:00Z","query":"how does Sarah take her coffee","expectContains":["oat-milk flat white"],"expectAbsent":["double espresso"],"hops":1}]}
```

Other distractor scenarios: `prod-db-choice`, `editor-preference`,
`env-var-distractor`.

## Running the harness

`tsx` is a devDependency, so the harness runs straight from source — no build
step is required.

```sh
# Main dataset (from the repo root, targeting the server workspace):
npm -w packages/server run eval -- --dataset src/eval/fixtures/scenarios.jsonl --k 5

# Tiny bundled smoke fixtures:
npm -w packages/server run eval -- --smoke

# Directly via tsx (avoids the npm arg-forwarding quirk below):
npx tsx src/eval/index.ts --dataset src/eval/fixtures/scenarios.jsonl --k 5
npx tsx src/eval/index.ts --smoke

# Opt into the real embedding index (slower; exercises semantic fusion):
EVAL_EMBEDDINGS=1 npx tsx src/eval/index.ts --dataset src/eval/fixtures/scenarios.jsonl
```

**npm arg-forwarding quirk:** `npm run eval -- --flag` drops the flags on some
platforms (notably the Windows npm cmd shim). Env-var fallbacks cover that case:

```sh
EVAL_SMOKE=1 npm -w packages/server run eval
EVAL_DATASET=src/eval/fixtures/scenarios.jsonl EVAL_K=10 npm -w packages/server run eval
```

The default retriever ingests each scenario into an **isolated `mkdtemp` vault**
and cleans it up afterward, so nothing touches your real brain vault.

## Interpreting the temporal metrics — this is a baseline

Current cortexmd has **no bitemporal fact-validity model**. Recall fuses lexical
and semantic similarity with heat/recency/validity boosts, but it does not
reason about "what was true as of date X." So a query asked "as of" an early
timestamp will happily surface a fact that only became true later.

As a result, **`pointInTimeAccuracy` is expected to be low and `staleLeakRate`
high** on the temporal scenarios today. That poor number is the intended
**baseline**: the planned bitemporal-KG work must move it, and this harness
exists so that improvement is measured rather than guessed. `recallAtK` — the
non-temporal control — should already be reasonable.
