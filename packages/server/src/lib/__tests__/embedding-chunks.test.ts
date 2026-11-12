/**
 * Chunk-level vectors: chunk→note roll-up in searchSemantic, per-chunk hashes
 * (an edit re-embeds only changed chunks), compaction/removal with several
 * vectors per note, the v1 (one-vector-per-note) → chunk migration, and the
 * embedding-model change (separate index files, never a mixed index) — real
 * hnswlib-node, deterministic bag-of-words fake model.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-embchunks-'));
const vault = path.join(root, 'vault');
mkdirSync(vault, { recursive: true });
process.env.BRAIN_VAULT = vault;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-embchunks';
process.env.DASHBOARD_PASSWORD = 'test-embchunks';
process.env.ENABLE_EMBEDDINGS = 'false';
delete process.env.EMBEDDING_MODEL;
delete process.env.EMBEDDING_CHUNKING;

const { config, DEFAULT_EMBEDDING_MODEL } = await import('../../config.js');
const emb = await import('../embeddings.js');
const hnswlib: any = await import('hnswlib-node');
const HNSW = (hnswlib.default ?? hnswlib).HierarchicalNSW;
const hooks = emb.__embeddingsTestHooks;

afterAll(() => {
  hooks.reset();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Bag-of-words vector: each token lights one dimension → cosine ≈ word
 * overlap. Dimensions are handed out first-come (collision-free while the
 * vocabulary fits), then by hash.
 */
const embedCalls: string[] = [];
const vocab = new Map<string, number>();
function bow(text: string, dim = config.embeddingDimension): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().match(/[a-zà-ÿ0-9]+/g) ?? []) {
    let d = vocab.get(tok);
    if (d === undefined) {
      d = vocab.size < dim ? vocab.size : createHash('md5').update(tok).digest().readUInt32LE(0) % dim;
      vocab.set(tok, d);
    }
    v[d % dim] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
function install(opts: { model?: string; dimension?: number } = {}): void {
  const dim = opts.dimension ?? config.embeddingDimension;
  hooks.install({ embed: (t: string) => { embedCalls.push(t); return bow(t, dim); }, hnsw: HNSW, capacity: 2000, ...opts });
  embedCalls.length = 0;
}

const filler = (word: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${word}${i} ${word} filler line about ${word} number ${i}.`).join('\n');

/** A long note: the needle only appears deep in the body (past the lead). */
function longNote(needle: string): { title: string; content: string } {
  return {
    title: 'Long note',
    content: ['# Intro', '', filler('alpha', 40), '', '## Middle', '', filler('beta', 40), '', '## Deep section', '',
      `The ${needle} lives here, far past the first thousand characters.`, '', filler('gamma', 20)].join('\n'),
  };
}

describe('chunk-level vectors', () => {
  beforeEach(() => install());

  it('short notes keep exactly one legacy-identical vector', async () => {
    const doc = { title: 'Tiny', content: 'just a few words' };
    expect(emb.planChunks(doc)).toHaveLength(1);
    await emb.embedAndIndex('tiny.md', doc);
    expect(embedCalls).toEqual([emb.embedTextFor(doc)]);
    expect(hooks.chunksOf('tiny.md')).toHaveLength(1);
    expect(hooks.hashOf('tiny.md')).toBe(emb.docHash(emb.embedTextFor(doc)));
    expect(emb.getEmbeddingStats()).toMatchObject({ indexSize: 1, vectors: 1, chunking: true });
  });

  it('long notes get a lead vector + section vectors, capped per note', async () => {
    const doc = longNote('zebra');
    const plan = emb.planChunks(doc);
    expect(plan.length).toBeGreaterThan(3);
    expect(plan.length).toBeLessThanOrEqual(config.embeddingMaxChunks + 1);
    expect(plan[0].text).toBe(emb.embedTextFor(doc));
    await emb.embedAndIndex('long.md', doc);
    expect(hooks.chunksOf('long.md').map((c) => c.hash)).toEqual(plan.map((c) => c.hash));
    expect(emb.getEmbeddingStats()).toMatchObject({ indexSize: 1, vectors: plan.length });

    const huge = { title: 'Huge', content: filler('delta', 4000) };
    expect(emb.planChunks(huge)).toHaveLength(config.embeddingMaxChunks + 1);
  });

  it('searchSemantic rolls chunks up to ONE hit per note and returns the best chunk + offsets', async () => {
    const doc = longNote('zebra');
    await emb.embedAndIndex('long.md', doc);
    await emb.embedAndIndex('other.md', { title: 'Other', content: 'completely unrelated words about cooking pasta' });
    await emb.embedAndIndex('other2.md', { title: 'Other two', content: 'alpha alpha alpha filler' });

    const hits = await emb.searchSemantic('where does the zebra live', 10, { withText: false });
    expect(hits.filter((h) => h.path === 'long.md')).toHaveLength(1);
    expect(new Set(hits.map((h) => h.path)).size).toBe(hits.length);
    const top = hits[0];
    expect(top.path).toBe('long.md');
    expect(top.chunk).toBeDefined();
    expect(top.chunk!.start).toBeGreaterThan(1024); // found past the legacy lead window
    expect(doc.content.slice(top.chunk!.start, top.chunk!.end)).toContain('zebra');
    expect(top.matchedChunks).toBeGreaterThanOrEqual(1);
    // Scores are sorted and the shape stays {path, score} compatible.
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);

    // Roll-up modes: top2 can only lower a multi-chunk note's score.
    const t2 = await emb.searchSemantic('where does the zebra live', 10, { rollup: 'top2', withText: false });
    expect(t2.find((h) => h.path === 'long.md')!.score).toBeLessThanOrEqual(top.score);

    // limit counts NOTES, not chunks.
    expect(await emb.searchSemantic('alpha filler', 2, { withText: false })).toHaveLength(2);

    const best = await emb.bestChunksFor('zebra', ['long.md', 'missing.md'], { withText: false });
    expect([...best.keys()]).toEqual(['long.md']);
    expect(best.get('long.md')!.start).toBe(top.chunk!.start);
  });

  it('an edit re-embeds only the chunks whose text changed', async () => {
    const doc = longNote('zebra');
    await emb.embedAndIndex('long.md', doc);
    const before = hooks.chunksOf('long.md');
    embedCalls.length = 0;

    // Same body → nothing to do (frontmatter-only edit).
    expect(await emb.embedAndIndex('long.md', { ...doc })).toBe('unchanged');
    expect(embedCalls).toHaveLength(0);

    // Edit a sentence deep in the note.
    const edited = { ...doc, content: doc.content.replace('zebra', 'okapi') };
    expect(await emb.embedAndIndex('long.md', edited)).toBe('embedded');
    const after = hooks.chunksOf('long.md');
    expect(after).toHaveLength(before.length);
    const changed = after.filter((c, i) => c.hash !== before[i].hash);
    expect(changed.length).toBeGreaterThanOrEqual(1);
    expect(changed.length).toBeLessThanOrEqual(2); // the chunk (+ its overlap neighbour)
    expect(embedCalls).toHaveLength(changed.length);
    // Untouched chunks kept their HNSW label (no native work).
    for (let i = 0; i < after.length; i++) {
      if (after[i].hash === before[i].hash) expect(after[i].id).toBe(before[i].id);
    }
    expect(emb.getEmbeddingStats().deletedSlots).toBe(changed.length);
    const hits = await emb.searchSemantic('okapi', 3, { withText: false });
    expect(hits[0].path).toBe('long.md');
  });

  it('removal drops every chunk; compaction renumbers and keeps chunks searchable', async () => {
    const a = longNote('zebra');
    const b = { ...longNote('quokka'), title: 'Second long' };
    await emb.embedAndIndex('a.md', a);
    await emb.embedAndIndex('b.md', b);
    await emb.embedAndIndex('a.md', { ...a, content: a.content.replace('zebra', 'okapi') });
    const live = hooks.chunksOf('a.md').length + hooks.chunksOf('b.md').length;
    expect(emb.getEmbeddingStats().vectors).toBe(live);
    expect(emb.getEmbeddingStats().deletedSlots).toBeGreaterThan(0);

    const res = await emb.compactIndex({ chunk: 3 });
    expect(res).toMatchObject({ live });
    expect(emb.getEmbeddingStats()).toMatchObject({ deletedSlots: 0, vectors: live, indexSize: 2 });
    const labels = [...hooks.chunksOf('a.md'), ...hooks.chunksOf('b.md')].map((c) => c.id).sort((x, y) => x - y);
    expect(labels).toEqual(Array.from({ length: live }, (_, i) => i));
    expect((await emb.searchSemantic('quokka', 1, { withText: false }))[0].path).toBe('b.md');
    expect((await emb.searchSemantic('okapi', 1, { withText: false }))[0].path).toBe('a.md');

    emb.removeFromVectorIndex('a.md');
    await hooks.idle();
    expect(hooks.chunksOf('a.md')).toEqual([]);
    expect(emb.getEmbeddingStats()).toMatchObject({ indexSize: 1, vectors: hooks.chunksOf('b.md').length });
    expect((await emb.searchSemantic('okapi alpha beta', 5, { withText: false })).map((h) => h.path)).toEqual(['b.md']);
  });

  it('semantic duplicate check compares against whole notes (lead vectors), not buried sections', async () => {
    const doc = longNote('zebra');
    await emb.embedAndIndex('long.md', doc);
    await emb.embedAndIndex('short.md', { title: '', content: 'the quick brown fox jumps over the lazy dog' });
    const deep = doc.content.slice(doc.content.indexOf('## Deep section'));
    // The section's own vector would match at ~1.0 — but it is not a lead.
    expect((await emb.searchSemantic(deep, 1, { withText: false }))[0].path).toBe('long.md');
    const buried = await emb.checkSemanticDuplicate(deep, 0.92);
    expect(buried.isDuplicate).toBe(false);
    const copy = await emb.checkSemanticDuplicate('the quick brown fox jumps over the lazy dog', 0.92);
    expect(copy).toMatchObject({ isDuplicate: true, matchPath: 'short.md', mode: 'semantic' });
  });

  it('incremental sync drops vanished notes and counts notes, not chunks', async () => {
    const docs = new Map([
      ['a.md', longNote('zebra')],
      ['b.md', { title: 'B', content: 'short b' }],
    ]);
    expect(await emb.syncIndexIncremental(docs)).toEqual({ added: 2, updated: 0, removed: 0, unchanged: 0 });
    embedCalls.length = 0;
    expect(await emb.syncIndexIncremental(docs)).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(embedCalls).toHaveLength(0);
    docs.delete('a.md');
    expect(await emb.syncIndexIncremental(docs)).toEqual({ added: 0, updated: 0, removed: 1, unchanged: 1 });
    expect(emb.getEmbeddingStats()).toMatchObject({ indexSize: 1, vectors: 1 });
  });

  it('buildFullIndex embeds every chunk and persists a v2 map', async () => {
    const docs = new Map([
      ['a.md', longNote('zebra')],
      ['b.md', { title: 'B', content: 'short b' }],
    ]);
    await emb.buildFullIndex(docs);
    const expected = emb.planChunks(docs.get('a.md')!).length + 1;
    expect(emb.getEmbeddingStats()).toMatchObject({ indexSize: 2, vectors: expected });
    const map = JSON.parse(readFileSync(hooks.indexFiles().mapPath, 'utf-8'));
    expect(map).toMatchObject({ version: 2, model: DEFAULT_EMBEDDING_MODEL, dimension: config.embeddingDimension });
    expect(map.notes['a.md']).toHaveLength(expected - 1);
    expect(map.notes['b.md'][0][1]).toBe(emb.docHash('B short b'));
  });
});

describe('migration from a one-vector-per-note (v1) index', () => {
  it('keeps every existing vector and only embeds the missing section chunks', async () => {
    install();
    const long = longNote('zebra');
    const short = { title: 'Short', content: 'short body' };
    const { indexPath, mapPath } = hooks.indexFiles();
    expect(path.basename(indexPath)).toBe('index.hnsw');
    expect(path.basename(mapPath)).toBe('id-map.json');

    // A legacy index: one vector per note = embedTextFor(doc), v1 id-map.
    mkdirSync(path.dirname(indexPath), { recursive: true });
    const legacy = new HNSW('cosine', config.embeddingDimension);
    legacy.initIndex(100, config.hnswM, config.hnswEfConstruction);
    legacy.addPoint(bow(emb.embedTextFor(long)), 0);
    legacy.addPoint(bow(emb.embedTextFor(short)), 1);
    legacy.writeIndexSync(indexPath);
    writeFileSync(mapPath, JSON.stringify({
      pathToId: { 'long.md': 0, 'short.md': 1 },
      pathToHash: { 'long.md': emb.docHash(emb.embedTextFor(long)), 'short.md': emb.docHash(emb.embedTextFor(short)) },
      nextId: 2,
    }));

    install(); // fresh process
    expect(hooks.loadPersisted()).toBe(true);
    expect(emb.wasPersistedIndexLoaded()).toBe(true);
    expect(emb.getEmbeddingStats()).toMatchObject({ indexSize: 2, vectors: 2 });
    // The old vectors serve searches before any migration work happened.
    expect((await emb.searchSemantic('short body', 1, { withText: false }))[0].path).toBe('short.md');
    embedCalls.length = 0;

    const r = await emb.syncIndexIncremental(new Map([['long.md', long], ['short.md', short]]));
    expect(r).toEqual({ added: 0, updated: 1, removed: 0, unchanged: 1 });
    const plan = emb.planChunks(long);
    expect(embedCalls).toHaveLength(plan.length - 1);          // lead NOT re-embedded
    expect(embedCalls).not.toContain(emb.embedTextFor(long));
    expect(hooks.chunksOf('long.md')[0].id).toBe(0);            // legacy label kept
    expect(hooks.chunksOf('short.md')).toMatchObject([{ id: 1 }]);
    expect(emb.getEmbeddingStats()).toMatchObject({ vectors: plan.length + 1, deletedSlots: 0 });
    expect((await emb.searchSemantic('zebra', 1, { withText: false }))[0]).toMatchObject({ path: 'long.md' });

    // Persisted as v2; the next boot is a no-op.
    expect(JSON.parse(readFileSync(mapPath, 'utf-8')).version).toBe(2);
    install();
    expect(hooks.loadPersisted()).toBe(true);
    embedCalls.length = 0;
    expect(await emb.syncIndexIncremental(new Map([['long.md', long], ['short.md', short]])))
      .toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(embedCalls).toHaveLength(0);
  });

  it('a corrupt or unrecognised map is ignored (rebuild), never a crash', () => {
    install();
    const { indexPath, mapPath } = hooks.indexFiles();
    writeFileSync(mapPath, '{"something":"else"}');
    expect(hooks.loadPersisted()).toBe(false);
    writeFileSync(mapPath, 'not json');
    expect(hooks.loadPersisted()).toBe(false);
    writeFileSync(indexPath, 'garbage');
    writeFileSync(mapPath, JSON.stringify({ version: 2, model: DEFAULT_EMBEDDING_MODEL, dimension: config.embeddingDimension, nextId: 1, notes: { 'x.md': [[0, 'h', 0, 5]] } }));
    expect(hooks.loadPersisted()).toBe(false);
    expect(emb.getEmbeddingStats().indexSize).toBe(0);
  });
});

describe('embedding model / dimension change', () => {
  const docs = new Map([
    ['one.md', { title: 'One', content: 'first note about apples' }],
    ['two.md', { title: 'Two', content: 'second note about pears' }],
  ]);

  it('each (model, dimension) persists to its own files; a switch starts clean and switching back reuses the old index', async () => {
    // Model A = the default.
    install();
    for (const f of Object.values(hooks.indexFiles())) rmSync(f, { force: true });
    await emb.buildFullIndex(docs);
    const filesA = hooks.indexFiles();
    const bytesA = readFileSync(filesA.indexPath);
    const mapA = readFileSync(filesA.mapPath, 'utf-8');

    // Switch to model B with another dimension: different files, nothing to load.
    install({ model: 'Acme/multilingual-test', dimension: 96 });
    const filesB = hooks.indexFiles();
    expect(filesB.indexPath).not.toBe(filesA.indexPath);
    expect(path.basename(filesB.indexPath)).toBe('index-acme-multilingual-test-96.hnsw');
    expect(path.basename(filesB.mapPath)).toBe('id-map-acme-multilingual-test-96.json');
    expect(hooks.loadPersisted()).toBe(false);            // → caller runs a background full build
    expect(emb.wasPersistedIndexLoaded()).toBe(false);
    expect(emb.getEmbeddingStats()).toMatchObject({ model: 'Acme/multilingual-test', dimension: 96, indexSize: 0 });
    expect(await emb.searchSemantic('apples', 5)).toEqual([]); // empty, not a crash

    await emb.buildFullIndex(docs);
    expect(embedCalls).toHaveLength(2);                    // everything re-embedded with model B
    expect((await emb.searchSemantic('pears', 1, { withText: false }))[0].path).toBe('two.md');
    expect(JSON.parse(readFileSync(filesB.mapPath, 'utf-8'))).toMatchObject({ model: 'Acme/multilingual-test', dimension: 96 });
    // Model A's files are untouched.
    expect(readFileSync(filesA.indexPath).equals(bytesA)).toBe(true);
    expect(readFileSync(filesA.mapPath, 'utf-8')).toBe(mapA);

    // Same model, different dimension (e.g. Matryoshka truncation) is ALSO a separate index.
    install({ model: 'Acme/multilingual-test', dimension: 64 });
    expect(hooks.indexFiles().indexPath).not.toBe(filesB.indexPath);
    expect(hooks.loadPersisted()).toBe(false);

    // Back to model B, then to the default: each loads its own index, no re-embed.
    install({ model: 'Acme/multilingual-test', dimension: 96 });
    expect(hooks.loadPersisted()).toBe(true);
    expect(await emb.syncIndexIncremental(docs)).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });
    install();
    expect(hooks.loadPersisted()).toBe(true);
    expect(await emb.syncIndexIncremental(docs)).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(embedCalls).toHaveLength(0);
  });

  it('refuses an index file whose recorded model or dimension differs from the active one', async () => {
    install({ model: 'Acme/multilingual-test', dimension: 96 });
    const { mapPath } = hooks.indexFiles();
    expect(existsSync(mapPath)).toBe(true);
    const map = JSON.parse(readFileSync(mapPath, 'utf-8'));
    writeFileSync(mapPath, JSON.stringify({ ...map, model: 'Someone/else' }));
    expect(hooks.loadPersisted()).toBe(false);
    writeFileSync(mapPath, JSON.stringify({ ...map, dimension: 128 }));
    expect(hooks.loadPersisted()).toBe(false);
    expect(emb.getEmbeddingStats().indexSize).toBe(0);
    writeFileSync(mapPath, JSON.stringify(map));
    expect(hooks.loadPersisted()).toBe(true);
  });

  it('index tags: default model keeps the historical file names', () => {
    expect(emb.embeddingIndexTag(DEFAULT_EMBEDDING_MODEL, 384)).toBe('');
    expect(emb.embeddingIndexTag(DEFAULT_EMBEDDING_MODEL, 256)).toBe('-xenova-all-minilm-l6-v2-256');
    expect(emb.embeddingIndexTag('Xenova/multilingual-e5-small', 384)).toBe('-xenova-multilingual-e5-small-384');
  });
});
