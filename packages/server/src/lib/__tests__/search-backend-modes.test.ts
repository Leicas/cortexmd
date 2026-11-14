/**
 * SEARCH_BACKEND modes (docs/ARCHITECTURE.md §6) on a small invented vault:
 *   minisearch  default, no SQLite DB is created
 *   shadow      MiniSearch answers (results identical to minisearch mode, even
 *               when the shadow backend throws); SQLite follows the index
 *               build, indexNote and removeFromIndex; aggregates only
 *   sqlite      SQLite answers the lexical arm (+ document frequencies)
 *   fallback    a DB that cannot be opened → MiniSearch + degraded note
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LexicalBackend } from '../lexical/types.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-backend-modes-'));
const vault = path.join(root, 'vault');
mkdirSync(vault, { recursive: true });

process.env.BRAIN_VAULT = vault;
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'emb');
process.env.API_KEY = 'test-backend-modes';
process.env.DASHBOARD_PASSWORD = 'test-backend-modes';
process.env.ENABLE_EMBEDDINGS = 'false';
process.env.ENABLE_KG = 'false';
process.env.SEARCH_SHADOW_SAMPLE_RATE = '1';
process.env.SEARCH_SHADOW_MAX_PENDING = '64';

function put(rel: string, fm: Record<string, string>, body: string): void {
  const abs = path.join(vault, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(abs, `---\n${yaml}\n---\n${body}\n`);
}

put('Memories/decision/heron.md', { title: 'Heron migration decision', type: 'memory', date: '2026-03-02', tags: '[birds, migration]' },
  'We decided to track the heron migration along the river delta every spring.');
put('Memories/fact/kestrel.md', { title: 'Kestrel nesting box', type: 'memory', date: '2026-04-10', tags: '[birds]' },
  'The kestrel nesting box sits on the north barn; check it weekly in April.');
put('Memories/fact/delta.md', { title: 'River delta survey', type: 'memory', date: '2026-05-01' },
  'Survey of the river delta sediment, unrelated to birds but mentions migration of sandbars.');
put('Projects/greenhouse.md', { title: 'Greenhouse irrigation', type: 'project' },
  'Drip irrigation for the greenhouse tomatoes, timer set to six minutes.');
put('Projects/compost.md', { title: 'Compost rotation', type: 'project', archived: 'true' },
  'Turn the compost heap every fortnight; archived plan.');
put('Notes/recipes/bread.md', { title: 'Sourdough starter', tags: '[kitchen]' },
  'Feed the sourdough starter twice a day; rye flour works best for the starter.');
put('Notes/recipes/soup.md', { title: 'Leek soup', tags: '[kitchen]' },
  'Leek and potato soup, heron-free recipe from the river cottage.');
put('Notes/heronry.md', { title: 'Heronry visit notes' },
  'Visited the heronry near the delta; counted twelve heron nests and one kestrel.');

const QUERIES = ['heron migration', 'kestrel', 'river delta', 'sourdough starter rye', 'irrigation timer', 'herons', 'compost', 'nothingmatcheshere'];

type SearchModule = typeof import('../search.js');
let dataN = 0;

/** Fresh module graph with SEARCH_BACKEND=mode (config.ts reads env at import). */
async function load(mode: string, env: Record<string, string> = {}): Promise<SearchModule> {
  vi.resetModules();
  process.env.SEARCH_BACKEND = mode;
  process.env.DATA_DIR = path.join(root, `data-${mode}-${dataN++}`);
  delete process.env.LEXICAL_DB_PATH;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return import('../search.js');
}

function snapshot(search: SearchModule, opts: Parameters<SearchModule['searchNotes']>[1] = {}) {
  return QUERIES.map((q) => search.searchNotes(q, { limit: 5, ...opts }).map((r) => ({
    path: r.path, score: r.score, coverage: r.coverage, evidence: r.lexicalEvidence,
  })));
}

const opened: SearchModule[] = [];
afterAll(() => {
  for (const s of opened) s.closeLexicalBackend();
  rmSync(root, { recursive: true, force: true });
});

let reference: ReturnType<typeof snapshot>;
let referenceFiltered: ReturnType<typeof snapshot>;

describe('SEARCH_BACKEND=minisearch (default)', () => {
  it('answers from MiniSearch and never creates the SQLite DB', async () => {
    const search = await load('minisearch');
    opened.push(search);
    await search.rebuildIndex();
    const st = search.getLexicalBackendStatus();
    expect(st).toMatchObject({ requested: 'minisearch', active: 'minisearch', degraded: null, shadow: null });
    expect(existsSync(path.join(process.env.DATA_DIR!, 'lexical.sqlite'))).toBe(false);
    reference = snapshot(search);
    referenceFiltered = snapshot(search, { type: 'memory', dateFrom: '2026-04-01' });
    expect(reference[0][0].path).toBe('Memories/decision/heron.md');
  });

  it('unknown values fall back to minisearch', async () => {
    const { config } = await (async () => { await load('elasticsearch'); return import('../../config.js'); })();
    expect(config.searchBackend).toBe('minisearch');
    expect(config.searchBackendRequested).toBe('elasticsearch');
  });
});

describe('SEARCH_BACKEND=shadow', () => {
  it('returns exactly the MiniSearch results and records aggregates only', async () => {
    const search = await load('shadow');
    opened.push(search);
    await search.rebuildIndex();
    await search.whenLexicalIdle();
    const st0 = search.getLexicalBackendStatus();
    expect(st0.active).toBe('shadow');
    expect(st0.synced).toBe(true);
    expect(st0.docs).toBe(8);
    expect(existsSync(path.join(process.env.DATA_DIR!, 'lexical.sqlite'))).toBe(true);

    expect(snapshot(search)).toEqual(reference);
    expect(snapshot(search, { type: 'memory', dateFrom: '2026-04-01' })).toEqual(referenceFiltered);
    await search.whenLexicalIdle();
    const sh = search.getLexicalBackendStatus().shadow!;
    expect(sh.queries).toBe(QUERIES.length * 2);
    expect(sh.errors).toBe(0);
    expect(sh.overlapAt10).toBeGreaterThan(0.8);
    expect(sh.top1Agreement).toBeGreaterThan(0.8);
    // Aggregates only: nothing query- or path-shaped leaks into the status.
    const json = JSON.stringify(search.getLexicalBackendStatus());
    expect(json).not.toMatch(/heron|kestrel|Memories\//);
  });

  it('a failing shadow backend never changes results', async () => {
    const search = await load('shadow');
    opened.push(search);
    const { SqliteLexicalBackend } = await import('../lexical-sqlite.js');
    const real = new SqliteLexicalBackend({ dbPath: ':memory:', toRecord: search.noteRecordFor });
    const broken: LexicalBackend = Object.create(real);
    broken.search = () => { throw new Error('boom'); };
    broken.upsert = () => { throw new Error('disk gone'); };
    search.setLexicalBackendFactoryForTests(() => broken);
    await search.rebuildIndex();
    await search.whenLexicalIdle();

    expect(snapshot(search)).toEqual(reference);
    await search.indexNote('Notes/heronry.md'); // upsert throws → logged, MiniSearch unaffected
    expect(snapshot(search)).toEqual(reference);
    await search.whenLexicalIdle();
    const st = search.getLexicalBackendStatus();
    expect(st.shadow!.errors).toBe(QUERIES.length * 2);
    expect(st.shadow!.queries).toBe(0);
    expect(st.writeErrors).toBe(1);
    real.close();
  });

  it('keeps the shadow index in sync with indexNote / removeFromIndex and rescans', async () => {
    const search = await load('shadow');
    opened.push(search);
    const { SqliteLexicalBackend } = await import('../lexical-sqlite.js');
    const be = new SqliteLexicalBackend({ dbPath: ':memory:', toRecord: search.noteRecordFor });
    search.setLexicalBackendFactoryForTests(() => be);
    await search.rebuildIndex();
    await search.whenLexicalIdle();
    expect(be.docCount()).toBe(8);

    put('Memories/fact/osprey.md', { title: 'Osprey platform', type: 'memory' }, 'An osprey platform was raised by the delta.');
    await search.indexNote('Memories/fact/osprey.md');
    expect(be.has('Memories/fact/osprey.md')).toBe(true);
    expect(be.search('osprey').map((h) => h.path)).toEqual(['Memories/fact/osprey.md']);

    search.removeFromIndex('Memories/fact/osprey.md');
    expect(be.has('Memories/fact/osprey.md')).toBe(false);
    unlinkSync(path.join(vault, 'Memories/fact/osprey.md'));

    // Rescan path: a file created / deleted on disk reaches the backend too.
    put('Notes/wren.md', { title: 'Wren song' }, 'The wren sings loudly at dawn.');
    await search.rebuildIndex();
    await search.whenLexicalIdle();
    expect(be.has('Notes/wren.md')).toBe(true);
    unlinkSync(path.join(vault, 'Notes/wren.md'));
    await search.rebuildIndex();
    await search.whenLexicalIdle();
    expect(be.has('Notes/wren.md')).toBe(false);
    expect(be.docCount()).toBe(8);
    be.close();
  });
});

describe('SEARCH_BACKEND=sqlite', () => {
  it('answers the lexical arm from SQLite without building MiniSearch', async () => {
    const search = await load('sqlite');
    opened.push(search);
    await search.rebuildIndex();
    const st = search.getLexicalBackendStatus();
    expect(st).toMatchObject({ requested: 'sqlite', active: 'sqlite', degraded: null, synced: true, docs: 8, shadow: null });

    const got = snapshot(search);
    // Same top hit as MiniSearch for every query with a clear answer.
    for (let i = 0; i < QUERIES.length; i++) {
      expect(got[i][0]?.path).toBe(reference[i][0]?.path);
      expect(new Set(got[i].map((r) => r.path))).toEqual(new Set(reference[i].map((r) => r.path)));
    }
    // Archived notes stay excluded; JS-only filters (dates) still apply.
    expect(search.searchNotes('compost')).toEqual([]);
    expect(search.searchNotes('compost', { excludeArchived: false })[0].path).toBe('Projects/compost.md');
    expect(search.searchNotes('delta', { type: 'memory', dateFrom: '2026-04-01' }).map((r) => r.path))
      .toEqual(['Memories/fact/delta.md']);
    expect(search.searchNotes('delta', { scopePaths: ['Notes/'] }).map((r) => r.path)).toEqual(['Notes/heronry.md']);
    // Document frequencies come from SQLite (rare term → higher IDF weight).
    const w = search.queryTermWeights('heron sourdough');
    expect(w.get('sourdough')!).toBeGreaterThan(w.get('heron')!);
  });

  it('indexNote / removeFromIndex / rescans update the SQLite answers', async () => {
    const search = await load('sqlite');
    opened.push(search);
    await search.rebuildIndex();
    put('Memories/fact/osprey.md', { title: 'Osprey platform', type: 'memory' }, 'An osprey platform was raised by the delta.');
    await search.indexNote('Memories/fact/osprey.md');
    expect(search.searchNotes('osprey').map((r) => r.path)).toEqual(['Memories/fact/osprey.md']);
    search.removeFromIndex('Memories/fact/osprey.md');
    expect(search.searchNotes('osprey')).toEqual([]);
    unlinkSync(path.join(vault, 'Memories/fact/osprey.md'));

    put('Notes/wren.md', { title: 'Wren song' }, 'The wren sings loudly at dawn.');
    await search.rebuildIndex();
    expect(search.searchNotes('wren').map((r) => r.path)).toEqual(['Notes/wren.md']);
    unlinkSync(path.join(vault, 'Notes/wren.md'));
    await search.rebuildIndex();
    expect(search.searchNotes('wren')).toEqual([]);
  });

  it('falls back to MiniSearch with one error and a degraded note when the DB cannot be opened', async () => {
    const blocker = path.join(root, 'not-a-dir');
    writeFileSync(blocker, 'a file where the DB directory should be');
    const search = await load('sqlite', { LEXICAL_DB_PATH: path.join(blocker, 'sub', 'lexical.sqlite') });
    opened.push(search);
    const { logger } = await import('../logger.js');
    const err = vi.spyOn(logger, 'error');
    await search.rebuildIndex();
    await search.rebuildIndex(); // opening is attempted once, not per rescan
    const st = search.getLexicalBackendStatus();
    expect(st.requested).toBe('sqlite');
    expect(st.active).toBe('minisearch');
    expect(st.degraded).toMatch(/failed to open.*serving MiniSearch/);
    expect(err.mock.calls.filter((c) => /lexical backend/i.test(String(c[0])))).toHaveLength(1);
    expect(snapshot(search)).toEqual(reference);
    err.mockRestore();
  });
});
