import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory vault: link-rewrite.ts only needs listFiles / readNote / writeNote.
const store = new Map<string, string>();

vi.mock('../../config.js', () => ({ config: { brainVault: 'vault' } }));
vi.mock('../vault.js', () => ({
  listFiles: async () => [...store.keys()].sort(),
  readNote: async (path: string) => {
    const content = store.get(path);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { content, etag: 'e' };
  },
  writeNote: async (path: string, content: string) => {
    store.set(path, content);
    return { etag: 'e' };
  },
}));
vi.mock('../search.js', () => ({ indexNote: async () => {} }));
vi.mock('../graph.js', () => ({ invalidateGraphCache: () => {} }));

const { rewriteInboundLinks } = await import('../link-rewrite.js');

const SRC = 'Memories/observation/2026/01/src-note.md';
const SUM = 'Memories/consolidated/tag-2026-W01.md';

beforeEach(() => {
  store.clear();
  store.set(SRC, 'source body');
  store.set(SUM, `### Src\n\n*Folded from [[${SRC}]]*\n`);
  store.set('Notes/a.md', `See [[src-note]] and [[${SRC}|the source]].\n| [[src-note\\|S]] |\n\`[[src-note]]\`\n`);
});

describe('rewriteInboundLinks', () => {
  it('re-points links at the consolidated note, keeping display text', async () => {
    const rewritten = await rewriteInboundLinks(SRC, SUM);
    expect(rewritten.sort()).toEqual([SUM, 'Notes/a.md']);
    expect(store.get('Notes/a.md')).toBe(
      'See [[Memories/consolidated/tag-2026-W01|src-note]] and [[Memories/consolidated/tag-2026-W01|the source]].\n' +
        '| [[Memories/consolidated/tag-2026-W01\\|S]] |\n`[[src-note]]`\n',
    );
    // The summary's own "Folded from" link becomes plain text, not a self-link
    expect(store.get(SUM)).toBe('### Src\n\n*Folded from src-note*\n');
  });

  it('flattens links to plain text without a replacement', async () => {
    await rewriteInboundLinks(SRC);
    expect(store.get('Notes/a.md')).toBe('See src-note and the source.\n| S |\n`[[src-note]]`\n');
  });

  it('flattens when consolidated_into points at a missing note', async () => {
    await rewriteInboundLinks(SRC, '[[Memories/consolidated/gone]]');
    expect(store.get('Notes/a.md')).toContain('See src-note and the source.');
  });

  it('leaves links to other notes alone', async () => {
    store.set('Notes/b.md', '[[Notes/a]] [[src-note-2]]');
    await rewriteInboundLinks(SRC, SUM);
    expect(store.get('Notes/b.md')).toBe('[[Notes/a]] [[src-note-2]]');
  });
});
