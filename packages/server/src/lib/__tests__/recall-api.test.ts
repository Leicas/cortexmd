import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-recall-api-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-recall-api';
process.env.DASHBOARD_PASSWORD = 'test-recall-api';
process.env.ENABLE_EMBEDDINGS = 'false';

const { recallForHook, validateRecallBody } = await import('../recall-api.js');
const { createNote } = await import('../vault.js');
const { rebuildIndex } = await import('../search.js');
const { stringifyFrontmatter } = await import('../frontmatter.js');

const today = new Date().toISOString().slice(0, 10);

function memory(title: string, body: string, extra: Record<string, unknown> = {}): string {
  return stringifyFrontmatter({
    type: 'memory', category: 'observation', title, importance: 'medium', temperature: 'warm',
    heat_score: 6, created: today, last_accessed: today, ...extra,
  }, `# ${title}\n\n${body}\n`);
}

const A = 'Memories/decision/2026/10/a-cortexmd.md';
const B = 'Memories/observation/2026/10/b-low.md';
const C = 'Memories/fact/c-other.md';
const N = 'Projects/sqlite-notes.md';
const E = 'EmailLog/observation/2026/10/e-mail.md';
const D = 'Ops/Agent Diaries/Claude Code (Ao)/2026-10-01.md';

beforeAll(async () => {
  await createNote(A, memory('SQLite index storage decision', 'We keep sqlite index storage on disk.', {
    category: 'decision', related: ['[[Projects/cortexmd]]'],
  }));
  await createNote(B, memory('SQLite index storage observed', 'Hook saw sqlite index storage grow.', {
    importance: 'low', tags: ['auto-capture'],
  }));
  await createNote(C, memory('SQLite index storage fact', 'sqlite index storage is used by [[Projects/other]].', {
    category: 'fact',
  }));
  await createNote(N, stringifyFrontmatter({ type: 'project', title: 'SQLite index storage notes' }, '# SQLite index storage notes\n\nsqlite index storage design.\n'));
  await createNote(E, memory('Email - sqlite index storage promo', 'sqlite index storage spam offer.', { tags: ['matrimail'] }));
  await createNote(D, '# Claude Code (Ao) — 2026-10-01\n\n- **10:00** — sqlite index storage work · [[Projects/cortexmd]] @ [[Machines/Ao]]\n');
  await rebuildIndex();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const QUERY = 'sqlite index storage';

describe('validateRecallBody', () => {
  it('rejects a missing query with status 400', () => {
    expect(() => validateRecallBody({})).toThrow(expect.objectContaining({ status: 400, message: 'query required' }));
    expect(() => validateRecallBody({ query: '   ' })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('clamps limit to 1..10 and defaults kinds/excludeArchived', () => {
    expect(validateRecallBody({ query: 'q', limit: 50 })).toMatchObject({ limit: 10, kinds: 'both', excludeArchived: true, seen: [] });
    expect(validateRecallBody({ query: 'q', limit: 0 }).limit).toBe(1);
  });

  it('rejects unknown kinds / minImportance', () => {
    expect(() => validateRecallBody({ query: 'q', kinds: 'all' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => validateRecallBody({ query: 'q', minImportance: 'urgent' })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('recallForHook', () => {
  it('splits memories and notes, excludes EmailLog and diaries, and carries importance', async () => {
    const res = await recallForHook({ query: QUERY, limit: 5 });
    expect(res.query).toBe(QUERY);
    const memPaths = res.memories.map((m) => m.path);
    expect(memPaths).toEqual(expect.arrayContaining([A, B, C]));
    expect(memPaths).not.toContain(E);
    expect(memPaths).not.toContain(N);
    expect(res.notes.map((n) => n.path)).toContain(N);
    expect(res.notes.map((n) => n.path)).not.toContain(D);
    expect(res.notes.map((n) => n.path)).not.toContain(E);
    for (const m of res.memories) {
      expect(m.importance).toBeDefined();
      expect(m.category).toBeDefined();
      expect(m.snippet.length).toBeLessThanOrEqual(200);
    }
  });

  it('drops paths in the seen-set before selection', async () => {
    const res = await recallForHook({ query: QUERY, limit: 5, seen: [A, N] });
    expect(res.memories.map((m) => m.path)).not.toContain(A);
    expect(res.memories.map((m) => m.path)).toEqual(expect.arrayContaining([B, C]));
    expect(res.notes.map((n) => n.path)).not.toContain(N);
  });

  it('boosts memories linked to the session project to the top', async () => {
    const cortex = await recallForHook({ query: QUERY, limit: 3, project: 'cortexmd', kinds: 'memory' });
    expect(cortex.memories[0].path).toBe(A);
    // Body wiki-links count as well as frontmatter `related`.
    const other = await recallForHook({ query: QUERY, limit: 3, project: 'Other', kinds: 'memory' });
    expect(other.memories[0].path).toBe(C);
  });

  it('honours minImportance so hooks can skip low-importance exhaust', async () => {
    const res = await recallForHook({ query: QUERY, limit: 5, minImportance: 'medium', kinds: 'memory' });
    const paths = res.memories.map((m) => m.path);
    expect(paths).not.toContain(B);
    expect(paths).toEqual(expect.arrayContaining([A, C]));
  });

  it('kinds=notes returns no memories and kinds=memory returns no notes', async () => {
    expect((await recallForHook({ query: QUERY, kinds: 'notes' })).memories).toEqual([]);
    expect((await recallForHook({ query: QUERY, kinds: 'memory' })).notes).toEqual([]);
  });
});
