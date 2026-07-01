import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Must set env before any imports that load config
process.env.API_KEY = 'test-key-for-unit-tests';

const tmpDir = mkdtempSync(join(tmpdir(), 'kg-test-'));

// Mock config to use our temp directory
vi.mock('../../config.js', () => ({
  config: {
    dataDir: tmpDir,
    logLevel: 'silent',
  },
}));

const {
  initKnowledgeGraph,
  shutdownKG,
  kgAddTriple,
  kgInvalidateTriple,
  kgQueryEntity,
  kgTimeline,
  kgStats,
  kgSearch,
  kgSupersede,
} = await import('../knowledge-graph.js');

const dbPath = join(tmpDir, 'knowledge-graph.sqlite');

describe('knowledge-graph', () => {
  beforeEach(() => {
    // Clean up any previous DB file to start fresh
    shutdownKG();
    try { unlinkSync(dbPath); } catch { /* may not exist */ }
    try { unlinkSync(dbPath + '-wal'); } catch { /* may not exist */ }
    try { unlinkSync(dbPath + '-shm'); } catch { /* may not exist */ }
    initKnowledgeGraph();
  });

  afterEach(() => {
    shutdownKG();
  });

  it('should create DB file on init', () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it('should add a triple and return id + created', () => {
    const result = kgAddTriple('Alice', 'works_with', 'Bob', {
      confidence: 0.9,
      source: 'conversation',
    });

    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe('string');
    expect(result.created).toBe(true);

    const { triples } = kgQueryEntity('Alice');
    const triple = triples.find((t) => t.predicate === 'works_with');
    expect(triple).toBeDefined();
    expect(triple!.subject).toBe('Alice');
    expect(triple!.object).toBe('Bob');
    expect(triple!.confidence).toBe(0.9);
    expect(triple!.source).toBe('conversation');
    expect(triple!.valid_to).toBeNull();
  });

  it('should return created=false for duplicate triple (upsert)', () => {
    const first = kgAddTriple('Alice', 'knows', 'Bob');
    const second = kgAddTriple('Alice', 'knows', 'Bob');

    expect(first.id).toBe(second.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it('should query entity triples (both directions by default)', () => {
    kgAddTriple('Alice', 'knows', 'Bob');
    kgAddTriple('Charlie', 'reports_to', 'Alice');

    const { entity, triples } = kgQueryEntity('Alice');
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe('Alice');
    expect(triples).toHaveLength(2);
  });

  it('should query entity with outgoing direction only', () => {
    kgAddTriple('Alice', 'knows', 'Bob');
    kgAddTriple('Charlie', 'reports_to', 'Alice');

    const { triples } = kgQueryEntity('Alice', 'outgoing');
    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe('Alice');
  });

  it('should query entity with incoming direction only', () => {
    kgAddTriple('Alice', 'knows', 'Bob');
    kgAddTriple('Charlie', 'reports_to', 'Alice');

    const { triples } = kgQueryEntity('Alice', 'incoming');
    expect(triples).toHaveLength(1);
    expect(triples[0].object).toBe('Alice');
  });

  it('should return null entity for unknown name', () => {
    const { entity, triples } = kgQueryEntity('Unknown');
    expect(entity).toBeNull();
    expect(triples).toHaveLength(0);
  });

  it('should invalidate a triple', () => {
    kgAddTriple('Alice', 'knows', 'Bob');

    const result = kgInvalidateTriple('Alice', 'knows', 'Bob');
    expect(result).toBe(true);

    const timeline = kgTimeline('Alice');
    expect(timeline).toHaveLength(1);
    expect(timeline[0].valid_to).not.toBeNull();
  });

  it('should return false when invalidating non-existent triple', () => {
    const result = kgInvalidateTriple('X', 'Y', 'Z');
    expect(result).toBe(false);
  });

  it('should report correct stats', () => {
    kgAddTriple('Alice', 'knows', 'Bob');
    kgAddTriple('Alice', 'manages', 'Charlie');
    kgInvalidateTriple('Alice', 'knows', 'Bob');

    const stats = kgStats();
    expect(stats.tripleCount).toBe(2);
    expect(stats.activeTriples).toBe(1);
    expect(stats.expiredTriples).toBe(1);
    expect(stats.entityCount).toBe(3);
    expect(Array.isArray(stats.topEntities)).toBe(true);
  });

  it('should search triples by text', () => {
    kgAddTriple('Alice', 'knows', 'Bob');
    kgAddTriple('Charlie', 'manages', 'Dave');

    const results = kgSearch('Alice');
    expect(results).toHaveLength(1);
    expect(results[0].subject).toBe('Alice');

    const results2 = kgSearch('manages');
    expect(results2).toHaveLength(1);
    expect(results2[0].predicate).toBe('manages');
  });

  it('should auto-create entities when adding triples', () => {
    kgAddTriple('Alice', 'knows', 'Bob');
    const stats = kgStats();
    expect(stats.entityCount).toBe(2);
  });

  // --- Bitemporal schema migration ---

  describe('bitemporal columns', () => {
    it('should expose transaction-time + supersession columns on new rows', () => {
      kgAddTriple('Alice', 'located_in', 'Building A', { validFrom: '2026-01-01' });
      const { triples } = kgQueryEntity('Alice', 'outgoing');
      const t = triples.find((x) => x.predicate === 'located_in')!;
      expect(t.recorded_at).toBeTruthy();          // stamped at insert
      expect(t.invalidated_at).toBeNull();          // live row
      expect(t.superseded_by).toBeNull();
      expect(t.supersedes).toBeNull();
    });

    it('kgInvalidateTriple stamps invalidated_at (transaction time)', () => {
      kgAddTriple('Alice', 'knows', 'Bob');
      kgInvalidateTriple('Alice', 'knows', 'Bob', '2026-03-01');
      const timeline = kgTimeline('Alice');
      expect(timeline[0].valid_to).toBe('2026-03-01');
      expect(timeline[0].invalidated_at).not.toBeNull();
    });
  });

  // --- Supersession primitive (close-and-link, never delete) ---

  describe('kgSupersede', () => {
    it('closes the prior rival and links both directions', () => {
      const first = kgAddTriple('team office', 'office_location', 'Building A', {
        validFrom: '2026-01-01',
        source: 'note-a.md',
      });

      const { newId, supersededIds } = kgSupersede(
        'team office',
        'office_location',
        'Building C',
        '2026-03-01',
        { source: 'note-c.md' },
      );

      expect(supersededIds).toEqual([first.id]);

      // Full history query returns BOTH rows — nothing is deleted.
      const { triples } = kgQueryEntity('team office', 'outgoing');
      expect(triples).toHaveLength(2);

      const oldRow = triples.find((t) => t.object === 'Building A')!;
      const newRow = triples.find((t) => t.object === 'Building C')!;

      // Old row: closed at the new fact's event time, transaction-invalidated,
      // and forward-linked to the replacement.
      expect(oldRow.valid_to).toBe('2026-03-01');
      expect(oldRow.invalidated_at).not.toBeNull();
      expect(oldRow.superseded_by).toBe(newId);

      // New row: live, and back-links to the fact it replaced.
      expect(newRow.id).toBe(newId);
      expect(newRow.valid_to).toBeNull();
      expect(newRow.invalidated_at).toBeNull();
      expect(newRow.supersedes).toBe(first.id);
    });

    it('never hard-deletes — superseded rows remain SELECT-able', () => {
      kgAddTriple('team office', 'office_location', 'Building A', { validFrom: '2026-01-01' });
      kgSupersede('team office', 'office_location', 'Building C', '2026-03-01');

      const stats = kgStats();
      expect(stats.tripleCount).toBe(2);        // both rows persist
      expect(stats.activeTriples).toBe(1);       // only the new one is event-active
      expect(stats.expiredTriples).toBe(1);
    });

    it('does not supersede facts with the same object (idempotent re-assert)', () => {
      const first = kgAddTriple('team office', 'office_location', 'Building A', { validFrom: '2026-01-01' });
      const { newId, supersededIds } = kgSupersede('team office', 'office_location', 'Building A', '2026-03-01');

      expect(newId).toBe(first.id);       // same triple id
      expect(supersededIds).toEqual([]);  // nothing closed
      const { triples } = kgQueryEntity('team office', 'outgoing');
      expect(triples).toHaveLength(1);
      expect(triples[0].valid_to).toBeNull();
    });

    it('closes multiple concurrent rivals in one call', () => {
      const a = kgAddTriple('billing service', 'primary_database', 'Postgres', { validFrom: '2026-01-01' });
      const b = kgAddTriple('billing service', 'primary_database', 'MySQL', { validFrom: '2026-01-02' });

      const { supersededIds } = kgSupersede('billing service', 'primary_database', 'DynamoDB', '2026-04-01');

      expect(supersededIds.sort()).toEqual([a.id, b.id].sort());
      const { triples } = kgQueryEntity('billing service', 'outgoing');
      const live = triples.filter((t) => t.valid_to === null);
      expect(live).toHaveLength(1);
      expect(live[0].object).toBe('DynamoDB');
    });

    it('does not clobber an already-set valid_to on a superseded rival', () => {
      kgAddTriple('team office', 'office_location', 'Building A', { validFrom: '2026-01-01' });
      // Manually end it earlier than the superseding fact's event time.
      kgInvalidateTriple('team office', 'office_location', 'Building A', '2026-02-15');
      // A closed (valid_to set) row is no longer transaction-active, so it is
      // NOT a rival and its valid_to is preserved.
      const { supersededIds } = kgSupersede('team office', 'office_location', 'Building C', '2026-03-01');
      expect(supersededIds).toEqual([]);

      const { triples } = kgQueryEntity('team office', 'outgoing');
      const oldRow = triples.find((t) => t.object === 'Building A')!;
      expect(oldRow.valid_to).toBe('2026-02-15');   // preserved, not clobbered
    });
  });

  // --- As-of (point-in-time) queries: half-open [valid_from, valid_to) ---

  describe('as-of queries', () => {
    beforeEach(() => {
      kgAddTriple('team office', 'office_location', 'Building A', { validFrom: '2026-01-01' });
      kgSupersede('team office', 'office_location', 'Building C', '2026-03-01');
    });

    it('returns the fact valid at an early instant (Building A)', () => {
      const { triples } = kgQueryEntity('team office', 'outgoing', '2026-02-01');
      expect(triples).toHaveLength(1);
      expect(triples[0].object).toBe('Building A');
    });

    it('returns the superseding fact at a later instant (Building C)', () => {
      const { triples } = kgQueryEntity('team office', 'outgoing', '2026-04-01');
      expect(triples).toHaveLength(1);
      expect(triples[0].object).toBe('Building C');
    });

    it('is half-open: valid_from is inclusive, valid_to is exclusive', () => {
      // Exactly at Building A's valid_from → included.
      expect(kgQueryEntity('team office', 'outgoing', '2026-01-01').triples.map((t) => t.object)).toEqual([
        'Building A',
      ]);
      // Exactly at the cutover (Building A.valid_to == Building C.valid_from ==
      // 2026-03-01): A is excluded (asOf >= valid_to), C is included.
      const atCutover = kgQueryEntity('team office', 'outgoing', '2026-03-01').triples.map((t) => t.object);
      expect(atCutover).toEqual(['Building C']);
    });

    it('without asOf returns full history (both rows)', () => {
      const { triples } = kgQueryEntity('team office', 'outgoing');
      expect(triples).toHaveLength(2);
    });
  });
});
