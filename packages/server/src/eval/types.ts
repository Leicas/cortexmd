/**
 * Temporal recall-quality eval harness — schema + types.
 *
 * A *dataset* is a JSONL file where each line is one {@link Scenario}. A
 * scenario models a timeline: a sequence of memory {@link ScenarioEvent}s
 * ingested in order, followed by point-in-time {@link ScenarioQuery}s that
 * probe what recall surfaces *as of* a given instant.
 *
 * The dataset agent depends on these exact field names — keep them stable.
 */

/**
 * A single memory written into the vault during a scenario. Events are
 * ingested in timeline order; `ts` is only advisory metadata for the current
 * (non-bitemporal) pipeline but the dataset carries it so future bitemporal
 * work can wire it into fact validity.
 */
export interface ScenarioEvent {
  /** ISO-8601 timestamp the memory became true / was recorded. */
  ts: string;
  /** Memory body (markdown). This is the text the retriever must surface. */
  content: string;
  /** Optional tags attached to the stored memory. */
  tags?: string[];
}

/**
 * A point-in-time recall probe. The "correct" answer is the fact that was
 * valid *as of* `ts` — later, superseding facts should NOT be surfaced.
 */
export interface ScenarioQuery {
  /**
   * ISO-8601 instant the query is asked "as of". The correct recall is the
   * fact valid at this point in time. (Current cortexmd has no bitemporal
   * validity, so this is aspirational — see the harness README.)
   */
  ts: string;
  /** Natural-language recall query. */
  query: string;
  /**
   * Substrings that a correct recall MUST surface in its top-k texts. A query
   * counts as a recall hit when every substring appears somewhere in the
   * concatenated top-k recalled texts (case-insensitive).
   */
  expectContains: string[];
  /**
   * Substrings from superseded / stale facts that must NOT appear in the
   * top-k texts. Any that leak in are counted by {@link staleLeakRate}.
   */
  expectAbsent?: string[];
  /**
   * Reasoning hops the correct answer requires (1 = direct lookup, 2 = one
   * indirection). Advisory; used for per-difficulty breakdowns later.
   */
  hops?: 1 | 2;
}

/** One timeline of events + the temporal queries probed against it. */
export interface Scenario {
  /** Stable unique id (used in per-scenario report rows). */
  id: string;
  /** Human-readable description of what this scenario tests. */
  description: string;
  /** Memories ingested in order before any query runs. */
  events: ScenarioEvent[];
  /** Point-in-time recall probes. */
  queries: ScenarioQuery[];
}

/** A whole dataset is just an ordered list of scenarios. */
export type Dataset = Scenario[];

/**
 * A retrieved item as returned by a {@link Retriever}. `text` is what the
 * scoring functions match `expectContains` / `expectAbsent` substrings
 * against; it should be the recalled memory body (optionally prefixed by
 * title). `path` and `score` are carried for debugging / report detail.
 */
export interface RetrievedItem {
  text: string;
  path?: string;
  score?: number;
}

/**
 * Pluggable recall backend. Given a query, its point-in-time `ts`, and `k`,
 * return the top-k recalled items (best-first). The DEFAULT retriever drives
 * the real cortexmd pipeline; unit tests inject a deterministic mock so
 * scoring/orchestration is testable without loading an embedding model.
 */
export type Retriever = (args: {
  query: string;
  ts: string;
  k: number;
}) => Promise<RetrievedItem[]>;

/** Per-query scoring outcome, retained for aggregation + debugging. */
export interface QueryResult {
  scenarioId: string;
  query: string;
  ts: string;
  hops?: 1 | 2;
  /** Top-k texts the retriever returned for this query. */
  retrievedTexts: string[];
  /** True when every `expectContains` substring appeared in the top-k. */
  recallHit: boolean;
  /**
   * True when this is a temporal query (has `expectAbsent`) AND it both
   * surfaced the valid fact and leaked NO stale fact — the point-in-time
   * "correct" condition.
   */
  pointInTimeCorrect: boolean;
  /** Whether this query carried `expectAbsent` (i.e. is a temporal probe). */
  isTemporal: boolean;
  /** True when any `expectAbsent` substring leaked into the top-k. */
  staleLeaked: boolean;
}

/** Per-scenario rollup inside the aggregate report. */
export interface PerScenarioReport {
  id: string;
  description: string;
  nQueries: number;
  recallAtK: number;
  pointInTimeAccuracy: number;
  staleLeakRate: number;
}

/** Aggregate report produced by {@link buildReport}. */
export interface EvalReport {
  /** Cutoff used for top-k scoring. */
  k: number;
  /** Fraction of queries whose `expectContains` were all surfaced in top-k. */
  recallAtK: number;
  /**
   * Fraction of *temporal* queries (those with `expectAbsent`) that surfaced
   * the valid fact AND leaked no stale fact.
   */
  pointInTimeAccuracy: number;
  /**
   * Fraction of *temporal* queries where at least one `expectAbsent` substring
   * leaked into the top-k.
   */
  staleLeakRate: number;
  nScenarios: number;
  nQueries: number;
  perScenario: PerScenarioReport[];
}
