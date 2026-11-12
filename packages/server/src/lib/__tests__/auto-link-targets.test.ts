import { beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  autoLink: true,
  autoLinkRelatedNotes: true,
  autoLinkRelatedMinScore: 0.03,
  autoLinkRelatedMax: 2,
  autoSeedKg: true,
  kgEnabled: true,
  autoSeedKgCategories: ['decision', 'fact', 'insight', 'preference', 'plan'],
  machineCaptureSourcePatterns: [] as string[],
}));
const docMeta = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const triples = vi.hoisted(() => [] as Array<[string, string, string]>);

vi.mock('../../config.js', () => ({ config: cfg }));
vi.mock('../search.js', () => ({ getDocMeta: () => docMeta }));
vi.mock('../entity-registry.js', () => ({ registerEntity: () => undefined, findEntity: () => undefined }));
vi.mock('../knowledge-graph.js', () => ({
  isKgInitialized: () => true,
  kgAddTriple: (s: string, p: string, o: string) => { triples.push([s, p, o]); },
}));
vi.mock('../logger.js', () => ({ logger: { warn: () => undefined, info: () => undefined } }));

const { selectAutoRelated, seedEntityKg, maySeedKg, AUTO_RELATED_HARD_CAP } = await import('../auto-link.js');

const note = (path: string, score: number, title = path) => ({ path, title, score, snippet: '' });

beforeEach(() => {
  docMeta.clear();
  triples.length = 0;
  cfg.autoLinkRelatedMax = 2;
});

describe('selectAutoRelated', () => {
  it('never links to digests, email captures or low-importance auto-captures', () => {
    docMeta.set('Memories/observation/2026/01/hook-note.md', { title: 'Cache warmup slow', tags: ['auto-capture'], importance: 'low' });
    docMeta.set('Memories/decision/2026/01/real.md', { title: 'Use Postgres for billing', tags: [], importance: 'high', type: 'memory' });
    const links = selectAutoRelated([
      note('Memories/consolidated/weekly-promo-2026-W10.md', 0.09),
      note('EmailLog/observation/2026/01/2026-01-02-email-sale.md', 0.08),
      note('Memories/observation/2026/01/hook-note.md', 0.07),
      note('Memories/decision/2026/01/real.md', 0.05),
    ]);
    expect(links).toEqual(['[[Memories/decision/2026/01/real.md]]']);
  });

  it('applies the raised score floor and the per-note cap', () => {
    const many = ['a', 'b', 'c', 'd'].map((x, i) => note(`Notes/${x}.md`, 0.06 - i * 0.001));
    expect(selectAutoRelated([...many, note('Notes/low.md', 0.025)])).toHaveLength(2);
    cfg.autoLinkRelatedMax = 50;
    expect(selectAutoRelated(Array.from({ length: 9 }, (_, i) => note(`Notes/n${i}.md`, 0.05)))).toHaveLength(AUTO_RELATED_HARD_CAP);
    expect(selectAutoRelated([note('Notes/low.md', 0.025)])).toEqual([]);
  });
});

describe('seedEntityKg', () => {
  const ents = [
    { name: 'Acme', type: 'organization' as const, confidence: 0.9 },
    { name: 'Dana', type: 'person' as const, confidence: 0.9 },
  ];

  it('seeds from deliberate decision/fact/insight/preference/plan notes', () => {
    seedEntityKg('Pick Acme as vendor', ents, 'Memories/decision/2026/01/pick.md');
    expect(triples.some(([, p]) => p === 'mentions_org')).toBe(true);
    expect(triples.some(([, p]) => p === 'co_mentioned')).toBe(true);
  });

  it('never seeds from email captures, digests, auto-captures or observations', () => {
    seedEntityKg('Email - promo', ents, 'EmailLog/observation/2026/01/promo.md');
    seedEntityKg('Weekly digest', ents, 'Memories/consolidated/w10.md');
    docMeta.set('Memories/fact/hooked.md', { tags: ['auto-capture'], category: 'fact' });
    seedEntityKg('hooked fact', ents, 'Memories/fact/hooked.md');
    seedEntityKg('n8n fact', ents, 'Memories/fact/n8n.md', { source: 'n8n:triage', category: 'fact' });
    seedEntityKg('Saw Acme', ents, 'Memories/observation/2026/01/saw.md');
    expect(triples).toEqual([]);
  });

  it('keeps curated uncategorised notes outside Memories/', () => {
    expect(maySeedKg('05 CRM/Entities/Acme.md')).toBe(true);
    expect(maySeedKg('Memories/uncategorised.md')).toBe(false);
  });
});
