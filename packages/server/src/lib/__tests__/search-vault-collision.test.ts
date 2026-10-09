import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Two vaults (brain + one read-only source vault) that share the SAME relative
// path. Before the per-vault mtime keying, each incremental rebuild saw the
// "other" vault's mtime as a change and re-indexed every shared path forever
// ("updated: ~1216" every 60 s on the live brain).
const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-vault-collision-'));
const brain = path.join(root, 'brain');
const source = path.join(root, 'perso');
mkdirSync(path.join(brain, 'Daily'), { recursive: true });
mkdirSync(path.join(source, 'Daily'), { recursive: true });

const SHARED = 'Daily/2026-01-01.md';
writeFileSync(path.join(brain, SHARED), '---\ntitle: brain copy\n---\n# brain copy\n');
writeFileSync(path.join(source, SHARED), '---\ntitle: source copy\n---\n# source copy\n');
writeFileSync(path.join(brain, 'only-brain.md'), '# only in brain\n');
writeFileSync(path.join(source, 'only-source.md'), '# only in source\n');
// Make the two shared copies differ in mtime (the churn trigger).
utimesSync(path.join(source, SHARED), new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
utimesSync(path.join(brain, SHARED), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

process.env.BRAIN_VAULT = brain;
process.env.VAULT_RO_PERSO = source;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-vault-collision';
process.env.DASHBOARD_PASSWORD = 'test-vault-collision';
process.env.ENABLE_EMBEDDINGS = 'false';
process.env.LOG_LEVEL = 'silent';

const { rebuildIndex, getDocMeta, getLastIndexUpdate, getIndexedNoteCount } = await import('../search.js');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('search index — cross-vault relPath collisions', () => {
  it('indexes a shared relPath once (first vault wins) and reports the collision', async () => {
    expect(getLastIndexUpdate()).toBeNull();
    await rebuildIndex();
    const first = getLastIndexUpdate();
    expect(first).not.toBeNull();
    expect(first!.collisions).toBe(1);
    expect(first!.removed).toBe(0);
    expect(typeof first!.ms).toBe('number');
    expect(() => new Date(first!.at).toISOString()).not.toThrow();

    // docMeta stays keyed by bare relPath; the brain (first vault) copy wins.
    const meta = getDocMeta();
    expect(meta.get(SHARED)?.title).toBe('brain copy');
    expect(meta.has('only-brain.md')).toBe(true);
    expect(meta.has('only-source.md')).toBe(true);
    expect(getIndexedNoteCount()).toBe(3);
  });

  it('does not churn on the next incremental rebuild (updated: 0, collisions: 1)', async () => {
    await rebuildIndex();
    const second = getLastIndexUpdate();
    expect(second).not.toBeNull();
    expect(second!.updated).toBe(0);
    expect(second!.removed).toBe(0);
    expect(second!.collisions).toBe(1);
    expect(getDocMeta().get(SHARED)?.title).toBe('brain copy');
    expect(getIndexedNoteCount()).toBe(3);

    // And again — steady state must stay at zero.
    await rebuildIndex();
    expect(getLastIndexUpdate()!.updated).toBe(0);
  });

  it('still re-indexes a genuinely changed file in the claiming vault', async () => {
    writeFileSync(path.join(brain, SHARED), '---\ntitle: brain copy v2\n---\n# brain copy v2\n');
    utimesSync(path.join(brain, SHARED), new Date('2026-01-03T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));
    await rebuildIndex();
    const upd = getLastIndexUpdate()!;
    expect(upd.updated).toBe(1);
    expect(upd.collisions).toBe(1);
    expect(getDocMeta().get(SHARED)?.title).toBe('brain copy v2');
  });

  it('drops a doc only when no vault lists its relPath any more', async () => {
    // Removing the brain copy hands the path to the source vault (no collision,
    // no removal — the doc is re-indexed from the surviving copy).
    rmSync(path.join(brain, SHARED));
    await rebuildIndex();
    let upd = getLastIndexUpdate()!;
    expect(upd.collisions).toBe(0);
    expect(upd.removed).toBe(0);
    expect(upd.updated).toBe(1);
    expect(getDocMeta().get(SHARED)?.title).toBe('source copy');

    rmSync(path.join(source, SHARED));
    await rebuildIndex();
    upd = getLastIndexUpdate()!;
    expect(upd.removed).toBe(1);
    expect(getDocMeta().has(SHARED)).toBe(false);
    expect(getIndexedNoteCount()).toBe(2);
  });
});
