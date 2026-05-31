import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Must set env + mock config before any imports that load config.
process.env.API_KEY = 'test-key-for-unit-tests';

const tmpDir = mkdtempSync(join(tmpdir(), 'entity-backfill-test-'));

vi.mock('../../config.js', () => ({
  config: {
    dataDir: tmpDir,
    logLevel: 'silent',
  },
}));

import type { BackfillDocMeta } from '../entity-backfill.js';
const { backfillEntities } = await import('../entity-backfill.js');
const { loadRegistry, listEntities, registerEntity, saveRegistry } = await import('../entity-registry.js');
const { initKnowledgeGraph, shutdownKG, kgStats } = await import('../knowledge-graph.js');

const registryPath = join(tmpDir, 'entity-registry.json');
const kgPath = join(tmpDir, 'knowledge-graph.sqlite');

/** A small corpus with obvious person / org / project mentions. */
function makeCorpus(): Map<string, BackfillDocMeta> {
  const dm = new Map<string, BackfillDocMeta>();
  dm.set('notes/meeting.md', {
    title: 'Meeting notes',
    collection: 'Notes',
    // Jane Doe: wiki-link (strong) + relationship verb → person
    // AcmeCorp: wiki-link (strong) + relationship verb → organization
    // phoenix-core: wiki-link (strong) + repo URL (strong) → project
    content:
      'We are building [[phoenix-core]]. Repo at github.com/acme/phoenix-core. ' +
      'Met with [[Jane Doe]]. Jane Doe leads it. ' +
      'Org [[AcmeCorp]] signed; we work with AcmeCorp.',
  });
  dm.set('notes/standup.md', {
    title: 'Standup',
    collection: 'Notes',
    // John Smith: relationship verb + possessive (2 weak signals)
    content: "Dr. John Smith presented. John Smith's research was great.",
  });
  // Archived note should be skipped entirely.
  dm.set('notes/old.md', {
    title: 'Old archived',
    collection: 'Notes',
    archived: true,
    content: "I worked with Zachary Quigley. Zachary Quigley's old plan.",
  });
  // Excluded collection should be skipped.
  dm.set('mail/spam.md', {
    title: 'Email log',
    collection: 'EmailLog',
    content: 'Message from Gregory Pemberton. Gregory Pemberton emailed again.',
  });
  return dm;
}

function resetRegistryFile(): void {
  try { unlinkSync(registryPath); } catch { /* may not exist */ }
  loadRegistry(); // reload empty in-memory state
}

beforeEach(() => {
  resetRegistryFile();
});

afterAll(() => {
  shutdownKG();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('entity-backfill', () => {
  it('populates the registry from the corpus (person/org/project), tier=detected', () => {
    const result = backfillEntities(makeCorpus(), { seedKg: false });

    // archived + EmailLog notes skipped → only 2 notes scanned
    expect(result.scanned).toBe(2);
    expect(result.uniqueEntities).toBeGreaterThan(0);
    expect(result.entitiesUpserted).toBeGreaterThanOrEqual(result.uniqueEntities);

    const entitiesByName = new Map(listEntities().map((e) => [e.name, e]));
    const names = [...entitiesByName.keys()];
    expect(names).toContain('Jane Doe');
    expect(names).toContain('John Smith');
    expect(names).toContain('AcmeCorp');
    expect(names).toContain('phoenix-core');

    // Types are preserved from the detector.
    expect(entitiesByName.get('Jane Doe')!.type).toBe('person');
    expect(entitiesByName.get('AcmeCorp')!.type).toBe('organization');
    expect(entitiesByName.get('phoenix-core')!.type).toBe('project');

    // Skipped notes' entities must NOT appear.
    expect(names).not.toContain('Zachary Quigley');
    expect(names).not.toContain('Gregory Pemberton');

    // Every backfilled entity is tier 'detected' and has a representative notePath.
    const jane = entitiesByName.get('Jane Doe')!;
    expect(jane.tier).toBe('detected');
    expect(jane.notePath).toBe('notes/meeting.md');
    expect(jane.occurrences).toBeGreaterThanOrEqual(1);
  });

  it('is idempotent on re-run: unique entity set is stable, occurrences accumulate', () => {
    const corpus = makeCorpus();
    backfillEntities(corpus, { seedKg: false });
    const firstNames = listEntities().map((e) => e.name).sort();
    const johnFirst = listEntities().find((e) => e.name === 'John Smith')!.occurrences;

    backfillEntities(corpus, { seedKg: false });
    const secondNames = listEntities().map((e) => e.name).sort();
    const johnSecond = listEntities().find((e) => e.name === 'John Smith')!.occurrences;

    // No duplicate explosion — same distinct set after re-run.
    expect(secondNames).toEqual(firstNames);
    // Occurrences accumulate (by design, matches incremental write hooks).
    expect(johnSecond).toBeGreaterThan(johnFirst);
  });

  it('never downgrades a confirmed entity', () => {
    // Pre-confirm John Smith.
    registerEntity('John Smith', 'person', { tier: 'confirmed' });
    saveRegistry();
    expect(listEntities().find((e) => e.name === 'John Smith')!.tier).toBe('confirmed');

    backfillEntities(makeCorpus(), { seedKg: false });

    const john = listEntities().find((e) => e.name === 'John Smith')!;
    expect(john.tier).toBe('confirmed'); // monotonic tier — not downgraded to 'detected'
    expect(john.confirmed).toBe(true);
  });

  it('respects minConfidence threshold', () => {
    // An impossibly high threshold registers nothing.
    const result = backfillEntities(makeCorpus(), { seedKg: false, minConfidence: 0.99 });
    expect(result.entitiesUpserted).toBe(0);
    expect(listEntities()).toHaveLength(0);
  });

  it('seeds the KG with mentions_* triples idempotently when enabled', () => {
    try { unlinkSync(kgPath); } catch { /* ignore */ }
    try { unlinkSync(kgPath + '-wal'); } catch { /* ignore */ }
    try { unlinkSync(kgPath + '-shm'); } catch { /* ignore */ }
    initKnowledgeGraph();

    const corpus = makeCorpus();
    const first = backfillEntities(corpus, { seedKg: true });
    expect(first.kgTriples).toBeGreaterThan(0);
    const triplesAfterFirst = kgStats().tripleCount;

    // Re-run: kgAddTriple is an md5 upsert, so no NEW triples are created.
    const second = backfillEntities(corpus, { seedKg: true });
    expect(second.kgTriples).toBe(0);
    expect(kgStats().tripleCount).toBe(triplesAfterFirst);
  });
});
