/**
 * Pure scoring functions for the temporal recall-quality harness.
 *
 * None of these touch the vault, the index, or an embedding model — they take
 * already-retrieved texts and the scenario's expectations and return numbers.
 * That keeps them trivially unit-testable and lets the same scorers grade both
 * a live end-to-end run and a mocked-retriever test.
 */

import type {
  Scenario,
  ScenarioQuery,
  QueryResult,
  PerScenarioReport,
  EvalReport,
} from './types.js';

/** Case-insensitive substring containment against the joined top-k texts. */
function joinedContains(haystack: string, needle: string): boolean {
  return haystack.includes(needle.toLowerCase());
}

/**
 * recall@k for a single query: did EVERY `expectContains` substring appear
 * somewhere in the top-k recalled texts? Returns true/false (an all-or-nothing
 * hit) so it aggregates cleanly into a fraction of hits across queries.
 *
 * An empty `expectContains` is vacuously satisfied (matches the existing
 * benchmark's "no ground truth ⇒ trivially true" convention).
 */
export function recallAtK(retrievedTexts: string[], expectContains: string[], k: number): boolean {
  if (expectContains.length === 0) return true;
  const haystack = retrievedTexts.slice(0, k).join('\n').toLowerCase();
  return expectContains.every((sub) => joinedContains(haystack, sub));
}

/**
 * staleLeak for a single query: did ANY `expectAbsent` substring leak into the
 * top-k recalled texts? These are superseded / stale facts that a correct
 * point-in-time recall must NOT surface. No `expectAbsent` ⇒ false (nothing to
 * leak).
 */
export function staleLeak(retrievedTexts: string[], expectAbsent: string[] | undefined, k: number): boolean {
  if (!expectAbsent || expectAbsent.length === 0) return false;
  const haystack = retrievedTexts.slice(0, k).join('\n').toLowerCase();
  return expectAbsent.some((sub) => joinedContains(haystack, sub));
}

/**
 * point-in-time correctness for a single query. Only meaningful for *temporal*
 * queries (those carrying `expectAbsent`). A temporal query is correct when it
 * BOTH surfaces the fact valid at `query.ts` (recall hit) AND leaks no stale
 * fact. Non-temporal queries return false here (they don't count toward
 * pointInTimeAccuracy — see {@link buildReport}).
 */
export function pointInTimeCorrect(retrievedTexts: string[], query: ScenarioQuery, k: number): boolean {
  const isTemporal = !!(query.expectAbsent && query.expectAbsent.length > 0);
  if (!isTemporal) return false;
  const hit = recallAtK(retrievedTexts, query.expectContains, k);
  const leaked = staleLeak(retrievedTexts, query.expectAbsent, k);
  return hit && !leaked;
}

/**
 * Grade one query's retrieved texts against its expectations into a
 * {@link QueryResult}. Pure — the retriever has already run.
 */
export function scoreQuery(scenario: Scenario, query: ScenarioQuery, retrievedTexts: string[], k: number): QueryResult {
  const isTemporal = !!(query.expectAbsent && query.expectAbsent.length > 0);
  const recallHit = recallAtK(retrievedTexts, query.expectContains, k);
  const leaked = staleLeak(retrievedTexts, query.expectAbsent, k);
  return {
    scenarioId: scenario.id,
    query: query.query,
    ts: query.ts,
    hops: query.hops,
    retrievedTexts: retrievedTexts.slice(0, k),
    recallHit,
    pointInTimeCorrect: isTemporal ? recallHit && !leaked : false,
    isTemporal,
    staleLeaked: leaked,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Aggregate per-query results into the report the harness/CLI prints.
 *
 * - recallAtK: fraction of ALL queries that were recall hits.
 * - pointInTimeAccuracy: fraction of TEMPORAL queries that were
 *   point-in-time correct (valid fact surfaced, stale fact absent). If there
 *   are no temporal queries it is 0.
 * - staleLeakRate: fraction of TEMPORAL queries that leaked a stale fact. 0
 *   when there are no temporal queries.
 *
 * `scenarios` is passed so per-scenario rows carry the id/description even for
 * scenarios whose every query was graded.
 */
export function buildReport(scenarios: Scenario[], results: QueryResult[], k: number): EvalReport {
  const nQueries = results.length;
  const recallHits = results.filter((r) => r.recallHit).length;

  const temporal = results.filter((r) => r.isTemporal);
  const pitCorrect = temporal.filter((r) => r.pointInTimeCorrect).length;
  const leaked = temporal.filter((r) => r.staleLeaked).length;

  const byScenario = new Map<string, QueryResult[]>();
  for (const r of results) {
    const arr = byScenario.get(r.scenarioId) ?? [];
    arr.push(r);
    byScenario.set(r.scenarioId, arr);
  }

  const perScenario: PerScenarioReport[] = scenarios.map((s) => {
    const rs = byScenario.get(s.id) ?? [];
    const n = rs.length;
    const hits = rs.filter((r) => r.recallHit).length;
    const temp = rs.filter((r) => r.isTemporal);
    const tPit = temp.filter((r) => r.pointInTimeCorrect).length;
    const tLeak = temp.filter((r) => r.staleLeaked).length;
    return {
      id: s.id,
      description: s.description,
      nQueries: n,
      recallAtK: n > 0 ? round4(hits / n) : 0,
      pointInTimeAccuracy: temp.length > 0 ? round4(tPit / temp.length) : 0,
      staleLeakRate: temp.length > 0 ? round4(tLeak / temp.length) : 0,
    };
  });

  return {
    k,
    recallAtK: nQueries > 0 ? round4(recallHits / nQueries) : 0,
    pointInTimeAccuracy: temporal.length > 0 ? round4(pitCorrect / temporal.length) : 0,
    staleLeakRate: temporal.length > 0 ? round4(leaked / temporal.length) : 0,
    nScenarios: scenarios.length,
    nQueries,
    perScenario,
  };
}
