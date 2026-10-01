import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory vault (same shape as journal-diary-links.test.ts).
const store = new Map<string, string>();

vi.mock('../vault.js', () => ({
  readNote: async (path: string) => {
    const content = store.get(path);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { content, etag: `etag-${content.length}` };
  },
  writeNote: async (path: string, content: string) => {
    store.set(path, content);
    return { etag: `etag-${content.length}` };
  },
  listFiles: async (dir: string) => [...store.keys()].filter((p) => p.startsWith(dir + '/')).sort(),
}));

const { linkFromIndex } = await import('../index-notes.js');
const { appendJournalEntry, readAgentDiary, listAgentNames } = await import('../journal.js');
const { extractWikilinks } = await import('../markdown.js');

beforeEach(() => store.clear());

/** Every note except the root indexes must have an inbound link. */
function orphans(roots: string[]): string[] {
  const linked = new Set<string>();
  for (const content of store.values()) for (const t of extractWikilinks(content)) linked.add(`${t}.md`);
  return [...store.keys()].filter((p) => !linked.has(p) && !roots.includes(p));
}

describe('linkFromIndex', () => {
  it('creates the index, links it from its parent, and never duplicates', async () => {
    const idx = { path: 'X/X 2026-09.md', title: 'X — 2026-09' };
    const root = { path: 'X/X Index.md', title: 'X' };
    await linkFromIndex(idx, 'X/a.md', [root]);
    await linkFromIndex(idx, 'X/b.md', [root]);
    await linkFromIndex(idx, 'X/a.md', [root]);
    expect(store.get(idx.path)).toBe('# X — 2026-09\n\n- [[X/a]]\n- [[X/b]]\n');
    expect(store.get(root.path)).toBe('# X\n\n- [[X/X 2026-09]]\n');
  });
});

describe('appendJournalEntry index links', () => {
  it('links a new journal day from its month index', async () => {
    const { path } = await appendJournalEntry('event one');
    await appendJournalEntry('event two');
    const [, y, m] = path.match(/^Journal\/(\d{4})\/(\d{2})\//)!;
    expect(store.get(`Journal/${y}/${y}-${m}.md`)).toContain(`- [[${path.replace(/\.md$/, '')}]]`);
    expect(orphans(['Journal/Journal Index.md'])).toEqual([]);
  });

  it('links a new diary day from the per-agent index without polluting diary reads', async () => {
    const agent = 'Claude Code (Ao)';
    const { path } = await appendJournalEntry('did a thing', undefined, agent);
    expect(store.get(`Ops/Agent Diaries/${agent}.md`)).toContain(`- [[${path.replace(/\.md$/, '')}]]`);
    expect(store.get('Ops/Agent Diaries/Agent Diaries.md')).toContain(`[[Ops/Agent Diaries/${agent}]]`);
    expect(orphans(['Ops/Agent Diaries/Agent Diaries.md'])).toEqual([]);
    expect((await readAgentDiary(agent)).total).toBe(1);
    expect(await listAgentNames()).toEqual([agent]);
  });
});
