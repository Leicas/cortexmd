import { describe, it, expect } from 'vitest';
import {
  recallAtK,
  staleLeak,
  pointInTimeCorrect,
  scoreQuery,
  buildReport,
} from '../scoring.js';
import { runHarness } from '../runner.js';
import type { Scenario, ScenarioQuery, Retriever, RetrievedItem } from '../types.js';

describe('recallAtK', () => {
  it('is true only when every expectContains substring appears in top-k (case-insensitive)', () => {
    const texts = ['The office is in Building A', 'unrelated note'];
    expect(recallAtK(texts, ['building a'], 5)).toBe(true);
    expect(recallAtK(texts, ['Building A', 'office'], 5)).toBe(true);
    expect(recallAtK(texts, ['Building C'], 5)).toBe(false);
  });

  it('respects the k cutoff', () => {
    const texts = ['first', 'second has TARGET'];
    expect(recallAtK(texts, ['TARGET'], 2)).toBe(true);
    expect(recallAtK(texts, ['TARGET'], 1)).toBe(false);
  });

  it('is vacuously true for empty expectContains', () => {
    expect(recallAtK(['anything'], [], 5)).toBe(true);
  });
});

describe('staleLeak', () => {
  it('is true when any expectAbsent substring leaks into top-k', () => {
    expect(staleLeak(['Building A', 'Building C'], ['Building C'], 5)).toBe(true);
    expect(staleLeak(['Building A'], ['Building C'], 5)).toBe(false);
  });

  it('is false when there is nothing to exclude', () => {
    expect(staleLeak(['x'], undefined, 5)).toBe(false);
    expect(staleLeak(['x'], [], 5)).toBe(false);
  });
});

describe('pointInTimeCorrect', () => {
  const mkQuery = (over: Partial<ScenarioQuery>): ScenarioQuery => ({
    ts: '2026-02-01T00:00:00Z',
    query: 'q',
    expectContains: ['Building A'],
    expectAbsent: ['Building C'],
    ...over,
  });

  it('requires the valid fact surfaced AND the stale fact absent', () => {
    expect(pointInTimeCorrect(['Building A'], mkQuery({}), 5)).toBe(true);
    // stale fact leaked → not correct
    expect(pointInTimeCorrect(['Building A', 'Building C'], mkQuery({}), 5)).toBe(false);
    // valid fact missing → not correct
    expect(pointInTimeCorrect(['nothing relevant'], mkQuery({}), 5)).toBe(false);
  });

  it('returns false for non-temporal queries (no expectAbsent)', () => {
    expect(pointInTimeCorrect(['Building A'], mkQuery({ expectAbsent: undefined }), 5)).toBe(false);
  });
});

describe('buildReport', () => {
  const scenarios: Scenario[] = [
    {
      id: 's1',
      description: 'temporal',
      events: [],
      queries: [
        { ts: 't', query: 'a', expectContains: ['A'], expectAbsent: ['C'] },
        { ts: 't', query: 'b', expectContains: ['B'], expectAbsent: ['D'] },
      ],
    },
    {
      id: 's2',
      description: 'control',
      events: [],
      queries: [{ ts: 't', query: 'c', expectContains: ['X'] }],
    },
  ];

  it('aggregates recall, point-in-time accuracy, and stale-leak over the right denominators', () => {
    const results = [
      scoreQuery(scenarios[0], scenarios[0].queries[0], ['A'], 5), // hit, PIT-correct
      scoreQuery(scenarios[0], scenarios[0].queries[1], ['B', 'D'], 5), // hit but D leaked → PIT wrong + leak
      scoreQuery(scenarios[1], scenarios[1].queries[0], ['X'], 5), // non-temporal hit
    ];
    const report = buildReport(scenarios, results, 5);

    expect(report.k).toBe(5);
    expect(report.nScenarios).toBe(2);
    expect(report.nQueries).toBe(3);
    // 3/3 queries were recall hits
    expect(report.recallAtK).toBe(1);
    // 2 temporal queries, 1 point-in-time correct
    expect(report.pointInTimeAccuracy).toBe(0.5);
    // 2 temporal queries, 1 leaked
    expect(report.staleLeakRate).toBe(0.5);

    const s1 = report.perScenario.find((s) => s.id === 's1')!;
    expect(s1.nQueries).toBe(2);
    expect(s1.pointInTimeAccuracy).toBe(0.5);
    const s2 = report.perScenario.find((s) => s.id === 's2')!;
    // s2 has no temporal queries → temporal-derived metrics are 0
    expect(s2.pointInTimeAccuracy).toBe(0);
    expect(s2.staleLeakRate).toBe(0);
    expect(s2.recallAtK).toBe(1);
  });
});

describe('runHarness with a mock retriever', () => {
  // Two inline scenarios; the mock returns canned texts per query so no vault
  // or embedding model is touched — fast + deterministic.
  const scenarios: Scenario[] = [
    {
      id: 'office',
      description: 'superseded location',
      events: [
        { ts: '2026-01-10T00:00:00Z', content: 'office in Building A' },
        { ts: '2026-03-15T00:00:00Z', content: 'office moved to Building C' },
      ],
      queries: [
        {
          ts: '2026-02-01T00:00:00Z',
          query: 'where is the office',
          expectContains: ['Building A'],
          expectAbsent: ['Building C'],
        },
      ],
    },
    {
      id: 'db',
      description: 'stable decision',
      events: [{ ts: '2026-02-01T00:00:00Z', content: 'use PostgreSQL for billing' }],
      queries: [{ ts: '2026-06-01T00:00:00Z', query: 'which database', expectContains: ['PostgreSQL'] }],
    },
  ];

  it('produces a well-shaped report and grades the mock answers correctly', async () => {
    // Mock: a naive vector-store-like retriever that ALWAYS returns both office
    // facts (so the stale one leaks — the current-cortexmd baseline behavior)
    // and the correct db fact.
    const mock: Retriever = async ({ query }): Promise<RetrievedItem[]> => {
      if (query.includes('office')) {
        return [
          { text: 'office in Building A', score: 1 },
          { text: 'office moved to Building C', score: 0.9 },
        ];
      }
      return [{ text: 'use PostgreSQL for billing', score: 1 }];
    };

    const report = await runHarness(scenarios, { k: 5, retriever: mock });

    expect(report.nScenarios).toBe(2);
    expect(report.nQueries).toBe(2);
    // Both queries surface their expectContains → recall@k is 1.0.
    expect(report.recallAtK).toBe(1);
    // Only the office query is temporal; the stale "Building C" leaked, so
    // point-in-time accuracy is 0 and stale-leak rate is 1 — exactly the poor
    // baseline this harness is built to measure.
    expect(report.pointInTimeAccuracy).toBe(0);
    expect(report.staleLeakRate).toBe(1);
  });

  it('calls beginScenario and cleanup lifecycle hooks when present', async () => {
    const calls: string[] = [];
    const mock = (async () => [{ text: 'PostgreSQL' }]) as Retriever & {
      beginScenario?: (s: Scenario) => Promise<void>;
      cleanup?: () => Promise<void>;
    };
    mock.beginScenario = async (s) => {
      calls.push(`begin:${s.id}`);
    };
    mock.cleanup = async () => {
      calls.push('cleanup');
    };

    await runHarness(scenarios, { k: 3, retriever: mock });

    expect(calls).toEqual(['begin:office', 'begin:db', 'cleanup']);
  });
});
