import { describe, it, expect, vi } from 'vitest';

// docMeta fixture: one project note, two notes linking it (frontmatter
// `related` / body wiki-link), a diary day (excluded), an archived linker
// (excluded) and a hot unrelated note.
const docMeta = new Map<string, any>([
  ['Projects/cortexmd.md', { title: 'cortexmd', collection: 'projects', category: 'project', temperature: 'warm', heat_score: 7, tags: [], content: '# cortexmd' }],
  ['Memories/decision/2026/10/d1.md', { title: 'Use SQLite', collection: 'memories', category: 'decision', temperature: 'warm', heat_score: 8, tags: [], related: ['[[Projects/cortexmd]]'], content: 'sqlite' }],
  ['Memories/fact/f1.md', { title: 'Release flow', collection: 'memories', category: 'fact', temperature: 'cold', heat_score: 3, tags: [], content: 'see [[projects/CortexMD|the repo]]' }],
  ['Memories/fact/f2.md', { title: 'Archived linker', collection: 'memories', category: 'fact', temperature: 'cold', heat_score: 9, tags: [], archived: true, content: '[[Projects/cortexmd]]' }],
  ['Ops/Agent Diaries/Claude Code (Ao)/2026-10-01.md', { title: 'Claude Code (Ao) — 2026-10-01', collection: 'ops', category: 'diary', temperature: 'warm', heat_score: 6, tags: [], content: '- **10:00** — x · [[Projects/cortexmd]]' }],
  ['Memories/observation/2026/10/o1.md', { title: 'Hot unrelated', collection: 'memories', category: 'observation', temperature: 'hot', heat_score: 16, tags: [], content: 'nothing' }],
]);

vi.mock('../search.js', () => ({
  getDocMeta: () => docMeta,
  getIndexedNoteCount: () => docMeta.size,
}));
vi.mock('../../config.js', () => ({ config: { dataDir: '/nonexistent-cortexmd-test', identityFile: '' } }));
// memory-stack only needs projectSlug from journal.js; mocking it keeps the
// vault/source-vaults modules (and their config.brainVault) out of this test.
vi.mock('../journal.js', () => ({
  projectSlug: (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80),
}));

const { wakeUp } = await import('../memory-stack.js');

function l1(layers: Array<{ source: string; content: string }>): string {
  return layers.find((l) => l.source === 'top-memories')!.content;
}

describe('wakeUp with { project }', () => {
  it('opens L1 with a "this project" section listing the project note and its linkers, hottest first', async () => {
    const content = l1(await wakeUp(undefined, { project: 'cortexmd' }));
    const lines = content.split('\n');
    expect(lines[0]).toBe('### this project — [[Projects/cortexmd]]');
    expect(lines[1]).toContain('[[Projects/cortexmd|cortexmd]] -- project note');
    expect(lines[2]).toContain('[[Memories/decision/2026/10/d1|Use SQLite]]');
    expect(lines[3]).toContain('[[Memories/fact/f1|Release flow]]');
    const section = content.split('### memories')[0];
    expect(section).not.toContain('Archived linker');
    expect(section).not.toContain('Agent Diaries');
    expect(section).not.toContain('Hot unrelated');
    // Global sections still follow.
    expect(content).toContain('### memories');
    expect(content).toContain('Hot unrelated');
  });

  it('says so when nothing links the project yet', async () => {
    const content = l1(await wakeUp(undefined, { project: 'brand-new-repo' }));
    expect(content.split('\n')[0]).toBe('### this project — [[Projects/brand-new-repo]]');
    expect(content).toContain('_No notes link [[Projects/brand-new-repo]] yet._');
  });

  it('keeps the global narrative unchanged without a project and caches per project', async () => {
    const plain = l1(await wakeUp());
    expect(plain.startsWith('### this project')).toBe(false);
    const withProject = l1(await wakeUp(undefined, { project: 'cortexmd' }));
    expect(withProject).not.toBe(plain);
    // Second call for the same project hits the cache and is identical.
    expect(l1(await wakeUp(undefined, { project: 'cortexmd' }))).toBe(withProject);
    expect(l1(await wakeUp())).toBe(plain);
  });
});
