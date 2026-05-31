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
});
