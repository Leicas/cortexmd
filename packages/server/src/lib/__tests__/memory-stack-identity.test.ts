import { describe, it, expect, vi } from 'vitest';

// The server listens before the index is built, so getIdentity() can be
// called while the index is still empty. That result must not be cached.
const docMeta = new Map<string, any>();

vi.mock('../search.js', () => ({
  getDocMeta: () => docMeta,
  getIndexedNoteCount: () => docMeta.size,
}));
vi.mock('../../config.js', () => ({ config: { dataDir: '/nonexistent-cortexmd-test', identityFile: '' } }));
vi.mock('../journal.js', () => ({
  projectSlug: (text: string) => text.toLowerCase(),
}));

const { getIdentity } = await import('../memory-stack.js');

describe('getIdentity during indexing', () => {
  it('does not cache the empty-index stub, then caches the real one', async () => {
    expect(await getIdentity()).toContain('Vault with 0 notes');

    docMeta.set('Memories/fact/a.md', { title: 'A', collection: 'memories' });
    docMeta.set('Projects/p.md', { title: 'P', collection: 'projects' });
    const ready = await getIdentity();
    expect(ready).toContain('Vault with 2 notes across 2 collections');

    // Once the index has notes the line is cached for the TTL.
    docMeta.set('Memories/fact/b.md', { title: 'B', collection: 'memories' });
    expect(await getIdentity()).toBe(ready);
  });
});
