/**
 * Boot indexing: readiness state, overlap-guarded rebuilds, listing-order
 * preservation under concurrent reads, atomic swap on forced full rebuilds,
 * the link graph built from indexed links, and the tool-call readiness gate.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-indexboot-'));
const vault = path.join(root, 'vault');
mkdirSync(vault, { recursive: true });
process.env.BRAIN_VAULT = vault;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-indexboot';
process.env.DASHBOARD_PASSWORD = 'test-indexboot';
process.env.ENABLE_EMBEDDINGS = 'false';

const { config } = await import('../../config.js');
const search = await import('../search.js');
const state = await import('../index-state.js');
const graph = await import('../graph.js');
const { listFiles } = await import('../vault.js');
const { wrapToolHandler } = await import('../tool-wrapper.js');

afterAll(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, text: string): void {
  const abs = path.join(vault, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

const N = 120;
for (let i = 0; i < N; i++) {
  const links = i > 0 ? `[[n${i - 1}]] and [[Missing ${i}]]` : 'no links';
  put(`Notes/sub${i % 4}/n${i}.md`, `---\ntitle: Note ${i}\n${i % 10 === 0 ? 'related: ["[[n5]]"]\n' : ''}---\nBody ${i} ${links}\n`);
}

describe('boot index build', () => {
  it('reads files concurrently, indexes every note and reports readiness', async () => {
    // Graph built BEFORE any index build reads the files directly (reference).
    const graphFromFiles = await graph.buildLinkGraph();
    expect(state.getIndexState()).toBe('not_started');

    const p = search.rebuildIndex();
    expect(state.getIndexState()).toBe('indexing');
    // Overlapping calls (the 60 s rescan firing mid-boot) coalesce.
    const q = search.rebuildIndex();
    const r = search.rebuildIndex();
    await Promise.all([p, q, r]);
    expect(state.getIndexState()).toBe('ready');
    expect(state.getIndexProgress()).toEqual({ done: N, total: N });

    // (glob's listing order itself is not stable between calls, so compare as
    // sets; in-order application is covered by the forEachOrderedConcurrent test.)
    expect([...search.getDocMeta().keys()].sort()).toEqual((await listFiles(vault)).sort());
    expect(search.getIndexedNoteCount()).toBe(N);

    // Graph from indexed links (incl. frontmatter `related` links) == graph from files.
    const graphFromIndex = await graph.buildLinkGraph();
    expect(graphFromIndex).toEqual(graphFromFiles);
    expect(graphFromIndex.get('Notes/sub2/n10.md')).toContain('Notes/sub1/n5.md');
  });

  it('a forced full rebuild swaps atomically: readers never see an empty index', async () => {
    search.forceFullRebuild();
    const p = search.rebuildIndex();
    expect(search.getDocMeta().size).toBe(N);
    expect(search.searchNotes('Body', { limit: 5 }).length).toBeGreaterThan(0);
    await p;
    expect(search.getDocMeta().size).toBe(N);
    expect(state.getIndexState()).toBe('ready');
  });

  it('tool calls wait for the boot index, then fail with a clear INDEXING error on timeout', async () => {
    const saved = config.indexReadyWaitMs;
    config.indexReadyWaitMs = 30;
    try {
      let ran = 0;
      const tool = wrapToolHandler('notes_search', async () => {
        ran++;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      });

      state.setIndexState('indexing');
      const timedOut = await tool({}, {});
      expect(timedOut.isError).toBe(true);
      expect(timedOut.content[0].text).toMatch(/still indexing/);
      expect(timedOut.content[0].text).toMatch(/retry in a few seconds/);
      expect(ran).toBe(0);

      config.indexReadyWaitMs = 5_000;
      const waiting = tool({}, {});
      setTimeout(() => state.setIndexState('ready'), 20);
      const ok = await waiting;
      expect(ok.isError).toBeUndefined();
      expect(ran).toBe(1);
    } finally {
      config.indexReadyWaitMs = saved;
      state.setIndexState('ready');
    }
  });
});
