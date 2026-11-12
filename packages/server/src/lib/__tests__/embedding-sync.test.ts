/**
 * Embedding-sync consistency, rescan re-embedding, HNSW compaction and async
 * persistence — against the real hnswlib-node index with a deterministic fake
 * embedding model (no transformer download).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-embsync-'));
const vault = path.join(root, 'vault');
mkdirSync(vault, { recursive: true });
process.env.BRAIN_VAULT = vault;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-embsync';
process.env.DASHBOARD_PASSWORD = 'test-embsync';
process.env.ENABLE_EMBEDDINGS = 'false';

const { config } = await import('../../config.js');
const emb = await import('../embeddings.js');
const search = await import('../search.js');
const hnswlib: any = await import('hnswlib-node');
const HNSW = (hnswlib.default ?? hnswlib).HierarchicalNSW;

afterAll(() => {
  emb.__embeddingsTestHooks.reset();
  rmSync(root, { recursive: true, force: true });
});

/** Deterministic 384-d unit vector from the text (different text → different vector). */
const embedCalls: string[] = [];
function fakeEmbed(text: string): number[] {
  embedCalls.push(text);
  const out: number[] = [];
  let seed = createHash('sha256').update(text).digest();
  while (out.length < config.embeddingDimension) {
    for (const b of seed) out.push(b / 255 - 0.5);
    seed = createHash('sha256').update(seed).digest();
  }
  out.length = config.embeddingDimension;
  const norm = Math.hypot(...out);
  return out.map((v) => v / norm);
}

function install(capacity = 1000): void {
  emb.__embeddingsTestHooks.install({ embed: fakeEmbed, hnsw: HNSW, capacity });
  embedCalls.length = 0;
}

function note(rel: string, title: string, body: string, extra = ''): void {
  const abs = path.join(vault, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `---\ntitle: ${title}\n${extra}---\n${body}\n`);
}

function docsFromIndex(): Map<string, { title: string; content: string }> {
  const m = new Map<string, { title: string; content: string }>();
  for (const [p, meta] of search.getDocMeta()) m.set(p, { title: meta.title, content: meta.content });
  return m;
}

describe('one embed text everywhere (embedTextFor)', () => {
  beforeEach(() => install());

  it('the runtime write path and the boot sync produce the same hash — no re-embed on next boot', async () => {
    const doc = { title: 'Alpha', content: 'Body of alpha.' };
    expect(await emb.embedAndIndex('a.md', doc)).toBe('embedded');
    expect(embedCalls).toEqual([emb.embedTextFor(doc)]);
    expect(emb.__embeddingsTestHooks.hashOf('a.md')).toBe(emb.docHash(emb.embedTextFor(doc)));

    // Boot incremental sync over the same doc: nothing to do.
    const r = await emb.syncIndexIncremental(new Map([['a.md', doc]]));
    expect(r).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 1 });
    expect(embedCalls).toHaveLength(1);
  });

  it('skips the forward pass when only frontmatter changed (same title + body)', async () => {
    const doc = { title: 'Beta', content: 'Same body.' };
    await emb.embedAndIndex('b.md', doc);
    expect(await emb.embedAndIndex('b.md', { ...doc })).toBe('unchanged');
    expect(await emb.embedAndIndex('b.md', { title: 'Beta renamed', content: doc.content })).toBe('embedded');
    expect(embedCalls).toHaveLength(2);
  });

  it('a vector written by the old body-only runtime path is re-embedded once, then stable', async () => {
    const doc = { title: 'Gamma', content: 'Gamma body.' };
    // Simulate the legacy runtime path: embedded + hashed from the body alone.
    await emb.embedAndIndex('g.md', { title: '', content: doc.content });
    const r1 = await emb.syncIndexIncremental(new Map([['g.md', doc]]));
    expect(r1.updated).toBe(1);
    const r2 = await emb.syncIndexIncremental(new Map([['g.md', doc]]));
    expect(r2).toEqual({ added: 0, updated: 0, removed: 0, unchanged: 1 });
  });
});

describe('HNSW compaction', () => {
  beforeEach(() => install(2000));

  it('drops dead slots, renumbers labels, and keeps every live vector searchable', async () => {
    const n = 30;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < n; i++) {
        await emb.embedAndIndex(`n${i}.md`, { title: `T${i}`, content: `body ${i} v${round}` });
      }
    }
    const before = emb.getEmbeddingStats();
    expect(before.indexSize).toBe(n);
    expect(before.deletedSlots).toBe(3 * n);
    expect(emb.needsCompaction()).toBe(before.deletedSlots >= config.hnswCompactMinDeleted);

    const res = await emb.compactIndex({ chunk: 7 });
    expect(res).toEqual({ live: n, dropped: 3 * n });
    const after = emb.getEmbeddingStats();
    expect(after.deletedSlots).toBe(0);
    expect(after.indexSize).toBe(n);
    expect(after.compactions).toBe(1);
    expect(new Set(Array.from({ length: n }, (_, i) => emb.__embeddingsTestHooks.labelOf(`n${i}.md`)))).toEqual(
      new Set(Array.from({ length: n }, (_, i) => i)),
    );
    // Search by the exact current text finds its own note first.
    const idx = emb.__embeddingsTestHooks.nativeIndex();
    for (const i of [0, 7, 29]) {
      const q = fakeEmbed(emb.embedTextFor({ title: `T${i}`, content: `body ${i} v3` }));
      const hit = idx.searchKnn(q, 1).neighbors[0];
      expect(hit).toBe(emb.__embeddingsTestHooks.labelOf(`n${i}.md`));
    }
  });

  it('a removal that lands mid-compaction is honoured after the swap', async () => {
    for (let i = 0; i < 40; i++) await emb.embedAndIndex(`r${i}.md`, { title: `R${i}`, content: `x${i}` });
    for (let i = 0; i < 40; i++) await emb.embedAndIndex(`r${i}.md`, { title: `R${i}`, content: `y${i}` });
    const running = emb.compactIndex({ chunk: 5 });
    await new Promise((r) => setImmediate(r));
    emb.removeFromVectorIndex('r3.md');
    await running;
    await emb.__embeddingsTestHooks.idle();
    expect(emb.__embeddingsTestHooks.labelOf('r3.md')).toBeUndefined();
    expect(emb.getEmbeddingStats().indexSize).toBe(39);
    const ids = emb.__embeddingsTestHooks.nativeIndex().searchKnn(fakeEmbed('R3 y3'), 39).neighbors as number[];
    expect(ids).toHaveLength(39); // r3's copied slot was marked deleted in the new index
  });
});

describe('non-blocking persistence', () => {
  beforeEach(() => install());

  it('writes index + id-map atomically while mutations keep flowing', async () => {
    for (let i = 0; i < 20; i++) await emb.embedAndIndex(`p${i}.md`, { title: `P${i}`, content: `c${i}` });
    const persist = emb.persistIndexAsync();
    // Mutations issued during the write queue behind it instead of racing it.
    const during = Promise.all(
      Array.from({ length: 10 }, (_, i) => emb.embedAndIndex(`q${i}.md`, { title: `Q${i}`, content: `d${i}` })),
    );
    await Promise.all([persist, during]);
    await emb.persistIndexAsync();
    const files = readdirSync(config.embeddingsDataDir);
    expect(files).toContain('index.hnsw');
    expect(files).toContain('id-map.json');
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(emb.getEmbeddingStats().lastPersist).toBeGreaterThan(0);
  });
});

describe('rescan re-embeds notes changed outside the server', () => {
  it('embeds new/changed notes and drops vectors of deleted notes', async () => {
    note('Inbox/one.md', 'One', 'first body');
    note('Inbox/two.md', 'Two', 'second body');
    await search.rebuildIndex(); // boot build
    install();
    await emb.syncIndexIncremental(docsFromIndex()); // boot embedding sync
    expect(emb.getEmbeddingStats().indexSize).toBe(2);
    embedCalls.length = 0;

    // External edits: one changed (with a new mtime), one added, one deleted.
    note('Inbox/one.md', 'One', 'first body EDITED in Obsidian');
    const future = new Date(Date.now() + 5_000);
    utimesSync(path.join(vault, 'Inbox/one.md'), future, future);
    note('Inbox/three.md', 'Three', 'synced from another machine');
    unlinkSync(path.join(vault, 'Inbox/two.md'));

    await search.rebuildIndex(); // the 60 s rescan
    expect(emb.__embeddingsTestHooks.labelOf('Inbox/two.md')).toBeUndefined();
    expect(emb.__embeddingsTestHooks.pending()).toBe(2);
    const r = await emb.drainEmbedQueueOnce(10);
    expect(r).toMatchObject({ embedded: 2, failed: 0 });
    expect(emb.__embeddingsTestHooks.hashOf('Inbox/one.md')).toBe(
      emb.docHash(emb.embedTextFor({ title: 'One', content: search.getDocMeta().get('Inbox/one.md')!.content })),
    );
    expect(emb.__embeddingsTestHooks.labelOf('Inbox/three.md')).toBeDefined();
    expect(existsSync(path.join(vault, 'Inbox/two.md'))).toBe(false);
  });
});
