# Memory design review — 2026-09-25

## Implementation update — 2026-09-25

The follow-up implementation addresses the immediate source overwrite, incremental temporal indexing, first-wins wiki-link resolution, archived evidence retrieval, and access-as-truth feedback. Manual, automatic, and weekly consolidation now preserve originals at their paths; summaries are derived insights. Memory stores use unique create-only paths, writes with ETags are serialized within the server process, and KG assertions retain multiple evidence sources and separate historical A→B→A intervals. Dream decay is elapsed-time based and dry runs skip LLM requests. Focused regression tests use isolated temporary vaults. This section is an implementation update; the ranked findings below record the pre-change behavior.

The broader architecture remains open: durable cross-process mutation journaling, vault-qualified stable IDs across renames and multiple source vaults, a claim-level evidence coverage gate before archival, and a held-out production retrieval benchmark. The current smoke benchmark has only six queries and cannot establish graph-recall benefit. The local checkout also lacks five Tree-sitter grammar packages, preventing the parser test file and TypeScript build from completing; other server tests pass.

Review of checkout `09764c2`. Three parallel specialists covered storage/wiki links, recall, and dream/consolidation; the lead checked evidence and ran the existing isolated evaluation. Review only: no production source changes or live vault maintenance. The pre-existing edit to `crates/cli/hooks/precompact_diary_hook.mjs` was preserved. The remote code index was 42 days old; findings below were checked against local source.

## Recommendation

Build **one evidence-preserving memory lifecycle**, with canonical note identity and resolved wiki links shared by storage, dream and recall. Start with the concrete data-loss and temporal-index defects below. Better clustering or a larger dream model should follow reliable identities, preserved sources and meaningful evaluation.

A memory should distinguish:

- Original observation: immutable source content/revision, author/tool, observed time.
- Derived summary: explicitly generated, with exact source IDs, revisions and evidence excerpts.
- Assertion: confidence and validity window supported by evidence, with explicit supersession.
- Salience: access frequency and usefulness, independent of truth.

## Ranked findings

### 1. Critical: consolidation can overwrite its own source

`packages/server/src/tools/memory-consolidate.ts:201-220` derives the canonical path from today's date, title and category. This matches the normal store path in `tools/memory-store.ts:148`. For a fact stored today, the canonical can equal its source. The write at `memory-consolidate.ts:276` replaces the source with a digest; the subsequent move at `:287` moves that new canonical away. Original full content is lost. Existing same-title canonical destinations can also be overwritten. `lib/vault.ts:464` performs an unconditional file write.

This is established by source inspection, not a destructive live reproduction. Fix immediately: reject source/destination equality, create canonical destinations without overwrite, preserve source paths, and make retries idempotent. A complete solution also needs revision checks and a recoverable operation record.

### 2. High: incremental indexing drops temporal validity

`lib/search.ts:282-284` loads `valid_from`, `valid_to` and `superseded_by` during a full rebuild. `:426-443` omits them when `indexNote` replaces the same metadata. `lib/bitemporal.ts:181-210` stamps a superseded note and then calls this incremental indexer. Immediate as-of recall therefore loses the closed validity window until a full rebuild restores it. The existing bitemporal tests mock `indexNote` and do not exercise that round trip.

Use one frontmatter-to-metadata mapper for both paths. Test storage → supersession → incremental index → immediate present/historical recall.

### 3. High: links can resolve silently to the wrong note

`lib/graph.ts:74-81` keeps the first basename match; `:284-307` has no ambiguity or source-relative resolution. Even a missing explicit `[[Projects/Foo]]` can fall back to another `Foo.md`. Recall duplicates this logic in `lib/search.ts:588-635`. `lib/auto-link.ts:58-59` emits bare canonical names rather than registry paths. `lib/project-reconcile.ts:295` emits titles that need not match filenames.

Introduce one resolver returning `resolved`, `ambiguous` or `missing`. Emit `[[canonical/path|Readable label]]` for known targets. An explicit missing path must never fall back silently to an unrelated basename. Handle aliases, headings, block references, relative references, moves and cross-vault identity explicitly.

### 4. High: repeated assertions overwrite provenance and reopen history

`lib/knowledge-graph.ts:145-151` replaces the source/confidence/valid-from of an existing subject-predicate-object triple and clears its closed validity and invalidation fields. A second supporting source replaces the first; re-ingestion can reopen an invalidated fact. Meanwhile wiki links use canonical names but KG seeding uses raw entity names (`lib/auto-link.ts:112,119`).

Separate assertions from evidence rows. Many sources may support one assertion. Replaying evidence must be idempotent and must not reopen a superseded assertion. Use the same entity registry for links and KG identities.

### 5. High: being retrieved is treated as proof

`tools/memory-recall.ts:465-489` increases Bayesian validity for displayed results without user relevance or truth feedback. `lib/memory-lifecycle.ts:580-620` promotes observations to facts after five cumulative accesses and recent last access; `lib/dream-engine.ts:771-780` applies promotions during non-dry dreams. Five accesses are not five independent confirmations.

Access should update salience only. Promote an observation to a verified assertion only through explicit evidence or confirmation. Serialize metadata updates: access tracking and validity currently perform competing asynchronous read-modify-writes.

### 6. High: summaries can make preserved evidence practically unreachable

`lib/memory-lifecycle.ts:385-418` places only the first 200 characters of each source in an active digest and archives the sources. Normal search excludes archived notes (`lib/search.ts:505-506`). Important details beyond the introduction may vanish from ordinary recall even though files survive.

Preserve original sources at stable paths and support source expansion from summaries. Require measured evidence coverage before reducing their direct retrieval visibility. Use explicit `derived_from` links and never present a snippet collection as a newly verified fact.

### 7. High: filtering after candidate limits can return no memories

`tools/memory-recall.ts:218-229` retrieves three times the requested count across all note types, then rejects nonmemory notes at `:264-270`. Enough highly ranked ordinary notes can crowd every memory out. Apply memory/category eligibility before candidate limits, or refill until the eligible result budget is satisfied.

### 8. Medium/high: graph projections diverge after writes

`lib/graph.ts:177-220` updates the written note but does not repair existing inbound references when a previously missing target appears. Consolidation moves do not invalidate this cache. `tools/notes-link-entities.ts:65-73` stores plain paths rather than wiki links and writes without direct graph/index refresh at `:88`. KG relationships exist separately; these are not traversable wiki edges.

PPR rebuilds a separate graph from search metadata, so it is inaccurate to say every recall shares this cache. Centrality and graph tools still use cached graph data. Unify mutation notifications and test incremental projections against a clean rebuild.

## Delivery sequence

1. **Contain data loss and incorrect recall:** consolidation collision guards/create-only writes; shared metadata mapper; pre-limit memory filtering. Add focused regression tests for each.
2. **Canonical links:** shared resolver, path-qualified generated links, ambiguity reporting, alias/path-history handling, inbound-reference repair. Initially retain existing IDs/paths and report ambiguous links; do not rewrite the vault blindly.
3. **Preserved evidence:** archive-in-place or stable-ID redirects, assertion/evidence separation, salience distinct from validity, summary-to-source expansion.
4. **Reliable dream:** one plan/apply contract shared by all consolidation modes. Plan contains source IDs/revisions/hashes, target IDs, proposed links and evidence coverage. Apply validates revisions, uses idempotency keys and records recoverable progress. Dry-run uses the same plan and shows exact changes. Decay depends on elapsed time, not invocation count.
5. **Measured quality:** evaluate the actual store/recall/dream handlers before enabling more aggressive consolidation or tuning model/ranking choices.

The smallest valuable architectural slice is the shared resolver plus canonical path links and consistent incremental indexing. It should follow the consolidation safety fix, without waiting for the full lifecycle redesign.

## Acceptance gates

- No source overwrite for today's fact, existing destination, concurrent write, interrupted apply or retry.
- Duplicate basenames/aliases never resolve arbitrarily; generated links resolve uniquely to intended source IDs.
- Creating, moving or deleting a target yields the same graph as a full rebuild.
- Re-ingesting an assertion retains all source evidence and preserves supersession.
- Repeated recall without confirmation does not increase epistemic confidence or turn observations into facts.
- Details after character 200 remain retrievable following consolidation.
- Immediate historical/current recall remains correct after incremental indexing.
- A matching memory remains retrievable among at least 100 strongly matching nonmemory distractors.
- Measure Recall@5, NDCG@5, stale-result rate, evidence coverage, link ambiguity/breakage, and p95 latency on an independently labeled held-out set. Compare identical budgets before/after; do not label the system's own top results as quality ground truth.

## Evaluation run and limitations

Executed from `packages/server`:

```powershell
node node_modules/tsx/dist/cli.mjs src/eval/index.ts --smoke --compare --out ../../.review-eval
```

Test-only dashboard/API values were set. Execution used isolated temporary vaults. The sandbox's Node user lookup failed; the same evaluation succeeded outside that restriction. Exit code 0. Artifacts: `../../.review-eval/eval-report.json` and `eval-history.jsonl`.

| Arm | Recall@5 | Point-in-time accuracy | Stale leak rate |
|---|---:|---:|---:|
| Baseline | 100% | 0% | 100% |
| Bitemporal | 100% | 100% | 0% |
| Graph/PPR | 100% | 0% | 100% |
| Graph + bitemporal | 100% | 100% | 0% |

Only three scenarios/six queries; embeddings were not enabled. The harness writes notes directly and calls `hybridSearch`, bypassing the full memory-store/recall handlers and automatic linking (`eval/runner.ts:222-233,268,306`). It demonstrates synthetic temporal behavior, not production quality or a graph benefit, and does not disprove the incremental-index defect.

The separate published Rescue@10 fixture ranks just two equal-base-score candidates (`lib/benchmark.ts:482-516`). Its current-note top-10 success is trivial with two candidates; the superseded-demotion assertion is useful as a unit check, but neither establishes real retrieval quality. Keep it labeled as a mechanism test and add distractor-rich handler-level evaluations.

No production tests were added and no fixes were implemented in this review. Static findings above still require regression reproductions before their fixes are considered validated.
