import { describe, it, expect } from 'vitest';
import { selectSessionsToEvict, pruneStaleSessionMeta, capSessionRecords } from '../session-lru.js';

interface S { lastActivity: number; name?: string }

function mapOf(entries: Array<[string, number]>): Map<string, S> {
  return new Map(entries.map(([id, lastActivity]) => [id, { lastActivity }]));
}

describe('selectSessionsToEvict', () => {
  it('returns nothing while under the cap', () => {
    const m = mapOf([['a', 1], ['b', 2]]);
    expect(selectSessionsToEvict(m, 3)).toEqual([]);
    expect(selectSessionsToEvict(m, 3, 1)).toEqual([]);
  });

  it('evicts the least-recently-active session when the cap is reached', () => {
    const m = mapOf([['old', 100], ['mid', 200], ['new', 300]]);
    expect(selectSessionsToEvict(m, 3, 1)).toEqual(['old']);
  });

  it('evicts enough sessions to make room for several incoming ones', () => {
    const m = mapOf([['a', 50], ['b', 10], ['c', 30], ['d', 40]]);
    // size 4, cap 4, incoming 3 → must drop 3, oldest first.
    expect(selectSessionsToEvict(m, 4, 3)).toEqual(['b', 'c', 'd']);
  });

  it('handles a map already over the cap (cap lowered at runtime)', () => {
    const m = mapOf([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]);
    expect(selectSessionsToEvict(m, 2, 1)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is disabled when maxActive <= 0', () => {
    const m = mapOf([['a', 1], ['b', 2]]);
    expect(selectSessionsToEvict(m, 0)).toEqual([]);
    expect(selectSessionsToEvict(m, -1)).toEqual([]);
  });

  it('does not mutate the input map', () => {
    const m = mapOf([['a', 1], ['b', 2]]);
    selectSessionsToEvict(m, 1);
    expect(m.size).toBe(2);
  });
});

describe('pruneStaleSessionMeta', () => {
  it('removes entries older than retentionMs and reports the count', () => {
    const now = 1_000_000;
    const m = mapOf([['fresh', now - 10], ['edge', now - 500], ['stale', now - 501], ['ancient', 0]]);
    expect(pruneStaleSessionMeta(m, 500, now)).toBe(2);
    expect(Array.from(m.keys()).sort()).toEqual(['edge', 'fresh']);
  });

  it('prunes nothing when retention is disabled', () => {
    const m = mapOf([['a', 0]]);
    expect(pruneStaleSessionMeta(m, 0, 10)).toBe(0);
    expect(m.size).toBe(1);
  });
});

describe('capSessionRecords', () => {
  it('sorts newest-first and slices to maxRecords', () => {
    const list: S[] = [{ lastActivity: 1, name: 'a' }, { lastActivity: 3, name: 'c' }, { lastActivity: 2, name: 'b' }];
    expect(capSessionRecords(list, 2).map((s) => s.name)).toEqual(['c', 'b']);
    expect(capSessionRecords(list, 0).map((s) => s.name)).toEqual(['c', 'b', 'a']);
    // input untouched
    expect(list.map((s) => s.name)).toEqual(['a', 'c', 'b']);
  });
});
