import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.API_KEY = 'test-key-for-unit-tests';

// Mutable config mock so we can flip the bitemporal flag per test and assert
// the dormancy contract. Everything else the module reads is inert here.
const mockConfig: { bitemporalKg: boolean; logLevel: string } = {
  bitemporalKg: false,
  logLevel: 'silent',
};
vi.mock('../../config.js', () => ({ config: mockConfig }));

// bitemporal.ts imports search.ts (indexNote), vault.ts (readNote/writeNote),
// and knowledge-graph.ts. For the dormancy + pure-function tests we stub the
// heavy deps so nothing touches disk or a real KG. isKgInitialized returns true
// so dormancy is proven to be driven purely by the FLAG, not by KG state.
const kgSupersede = vi.fn(() => ({ newId: 'newid', supersededIds: [] as string[] }));
const kgQueryEntity = vi.fn(() => ({ entity: null, triples: [] as any[] }));
vi.mock('../knowledge-graph.js', () => ({
  kgSupersede,
  kgQueryEntity,
  isKgInitialized: () => true,
}));
const writeNote = vi.fn(async (_path: string, _content: string, _ifMatch?: string) => ({ etag: 'x' }));
const readNote = vi.fn(async (_path: string) => ({ content: '---\n---\n', etag: 'x' }));
vi.mock('../vault.js', () => ({ writeNote, readNote }));
const indexNote = vi.fn(async () => {});
vi.mock('../search.js', () => ({ indexNote }));

const {
  extractFacts,
  withinWindow,
  SINGLE_VALUED,
  runSupersessionPass,
  runSupersessionForNotes,
} = await import('../bitemporal.js');

describe('bitemporal — extractFacts', () => {
  it('extracts an office-location fact from a "moved to" sentence', () => {
    const facts = extractFacts('office update', 'The office has moved to Building C, floor 3.');
    expect(facts).toEqual([
      { subject: 'team office', predicate: 'office_location', object: 'Building C' },
    ]);
  });

  it('extracts an office-location fact from an "is located in" sentence', () => {
    const facts = extractFacts('office', 'Our office is located in Building A right now.');
    expect(facts).toEqual([
      { subject: 'team office', predicate: 'office_location', object: 'Building A' },
    ]);
  });

  it('extracts a tech-lead role fact (project is subject, person is object)', () => {
    const facts = extractFacts('team', 'Dana is now the tech lead of Phoenix.');
    expect(facts).toEqual([
      { subject: 'Phoenix project', predicate: 'tech_lead_of', object: 'Dana' },
    ]);
  });

  it('extracts a primary-database fact', () => {
    const facts = extractFacts('arch', 'We chose Postgres as the primary database.');
    expect(facts).toEqual([
      { subject: 'billing service', predicate: 'primary_database', object: 'Postgres' },
    ]);
  });

  it('only emits predicates in the single-valued allowlist', () => {
    for (const f of extractFacts('x', 'the office moved to Building Q and Priya now leads Atlas')) {
      expect(SINGLE_VALUED.has(f.predicate)).toBe(true);
    }
  });

  it('returns nothing for prose that matches no rule', () => {
    expect(extractFacts('note', 'Just a normal observation with no facts.')).toEqual([]);
  });

  it('multi-valued predicates are NOT in the allowlist', () => {
    for (const p of ['mentions_person', 'co_mentioned', 'tagged', 'links_to', 'in_collection']) {
      expect(SINGLE_VALUED.has(p)).toBe(false);
    }
  });
});

describe('bitemporal — withinWindow (half-open [valid_from, valid_to))', () => {
  it('includes when no window is set', () => {
    expect(withinWindow(undefined, undefined, '2026-02-01T00:00:00Z')).toBe(true);
  });

  it('includes exactly at valid_from', () => {
    expect(withinWindow('2026-01-10', undefined, '2026-01-10')).toBe(true);
  });

  it('excludes before valid_from', () => {
    expect(withinWindow('2026-03-01', undefined, '2026-02-01')).toBe(false);
  });

  it('excludes exactly at valid_to (half-open upper bound)', () => {
    expect(withinWindow('2026-01-01', '2026-02-01', '2026-02-01')).toBe(false);
  });

  it('includes just before valid_to', () => {
    expect(withinWindow('2026-01-01', '2026-02-01', '2026-01-31')).toBe(true);
  });

  it('compares a YYYY-MM-DD note date against a full ISO instant query by day prefix', () => {
    // note valid 2026-01-10.. ; superseded at 2026-02-01. Query instant on 2026-01-15.
    expect(withinWindow('2026-01-10', '2026-02-01', '2026-01-15T09:30:00Z')).toBe(true);
    // Query instant on the closing day → excluded.
    expect(withinWindow('2026-01-10', '2026-02-01', '2026-02-01T09:30:00Z')).toBe(false);
  });
});

describe('bitemporal — dormancy (flag off)', () => {
  beforeEach(() => {
    mockConfig.bitemporalKg = false;
    kgSupersede.mockClear();
    writeNote.mockClear();
    indexNote.mockClear();
  });

  it('runSupersessionPass is a no-op when the flag is off', async () => {
    const res = await runSupersessionPass('Memories/x.md', { date: '2026-01-10' }, 'office moved to Building C');
    expect(res).toEqual({ applied: false, stamped: [] });
    expect(kgSupersede).not.toHaveBeenCalled();
    expect(writeNote).not.toHaveBeenCalled();
  });

  it('runSupersessionForNotes is a no-op when the flag is off', async () => {
    const res = await runSupersessionForNotes([
      { path: 'a.md', frontmatter: { date: '2026-01-10' }, body: 'office moved to Building C' },
    ]);
    expect(res).toEqual({ stamped: [] });
    expect(kgSupersede).not.toHaveBeenCalled();
  });
});

describe('bitemporal — active (flag on)', () => {
  beforeEach(() => {
    mockConfig.bitemporalKg = true;
    kgSupersede.mockReset();
    kgQueryEntity.mockReset();
    writeNote.mockReset();
    readNote.mockReset();
    indexNote.mockReset();
    readNote.mockResolvedValue({ content: '---\ndate: 2026-01-10\n---\nbody', etag: 'x' });
    writeNote.mockResolvedValue({ etag: 'x' });
    indexNote.mockResolvedValue(undefined);
  });

  it('calls kgSupersede for a derived single-valued fact using the note valid_from', async () => {
    kgSupersede.mockReturnValue({ newId: 'n1', supersededIds: [] });
    await runSupersessionPass('Memories/new.md', { date: '2026-02-01' }, 'The office has moved to Building C.');
    expect(kgSupersede).toHaveBeenCalledTimes(1);
    expect(kgSupersede).toHaveBeenCalledWith(
      'team office',
      'office_location',
      'Building C',
      '2026-02-01',
      { source: 'Memories/new.md' },
    );
  });

  it('stamps the earlier superseded source note (valid_to + superseded_by) and never deletes', async () => {
    kgSupersede.mockReturnValue({ newId: 'n1', supersededIds: ['oldTripleId'] });
    kgQueryEntity.mockReturnValue({
      entity: null,
      triples: [{ id: 'oldTripleId', source: 'Memories/old.md' } as any],
    });
    const res = await runSupersessionPass('Memories/new.md', { date: '2026-02-01' }, 'The office has moved to Building C.');

    expect(res.applied).toBe(true);
    expect(res.stamped).toEqual(['Memories/old.md']);
    // Stamped the earlier note with the closing window + forward link.
    expect(writeNote).toHaveBeenCalledTimes(1);
    const [stampedPath, stampedContent] = writeNote.mock.calls[0];
    expect(stampedPath).toBe('Memories/old.md');
    expect(stampedContent).toContain('valid_to');
    expect(stampedContent).toContain('2026-02-01');
    expect(stampedContent).toContain('superseded_by');
    expect(stampedContent).toContain('Memories/new.md');
    // Re-indexed so DocMeta picks up the new window.
    expect(indexNote).toHaveBeenCalledWith('Memories/old.md');
  });

  it('does not stamp when there is no superseded rival', async () => {
    kgSupersede.mockReturnValue({ newId: 'n1', supersededIds: [] });
    const res = await runSupersessionPass('Memories/new.md', { date: '2026-02-01' }, 'office moved to Building C');
    expect(res.stamped).toEqual([]);
    expect(writeNote).not.toHaveBeenCalled();
  });
});
