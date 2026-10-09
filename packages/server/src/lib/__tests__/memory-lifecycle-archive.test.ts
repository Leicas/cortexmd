import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-lifecycle-archive-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-lifecycle-archive';
process.env.DASHBOARD_PASSWORD = 'test-lifecycle-archive';
process.env.ENABLE_EMBEDDINGS = 'false';

const { createNote, readNote } = await import('../vault.js');
const { rebuildIndex } = await import('../search.js');
const { stringifyFrontmatter, parseFrontmatter } = await import('../frontmatter.js');
const { autoArchiveColdMemories, TEMPLATED_ARCHIVE_SAFE_TAGS, LOW_IMPORTANCE_ARCHIVE_TAGS } = await import('../memory-lifecycle.js');

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function memory(title: string, fm: Record<string, unknown>): string {
  return stringifyFrontmatter({ type: 'memory', category: 'observation', title, created: '2026-01-01', ...fm }, `# ${title}\n\nbody\n`);
}

const LOW_OLD = 'Memories/observation/2026/09/low-old.md';
const LOW_FRESH = 'Memories/observation/2026/10/low-fresh.md';
const MED_OLD = 'Memories/observation/2026/09/medium-old.md';
const LOW_HOT = 'Memories/observation/2026/09/low-hot.md';
const MAIL_OLD = 'EmailLog/observation/2026/09/mail-old.md';
const COLD_HOOK = 'Memories/observation/2026/06/cold-hook.md';
const COLD_UNIQUE = 'Memories/observation/2026/06/cold-unique.md';

beforeAll(async () => {
  await createNote(LOW_OLD, memory('low old', { importance: 'low', temperature: 'warm', tags: ['auto-capture'], last_accessed: daysAgo(40) }));
  await createNote(LOW_FRESH, memory('low fresh', { importance: 'low', temperature: 'warm', tags: ['auto-capture'], last_accessed: daysAgo(20) }));
  await createNote(MED_OLD, memory('medium old', { importance: 'medium', temperature: 'warm', tags: ['auto-capture'], last_accessed: daysAgo(40) }));
  await createNote(LOW_HOT, memory('low hot', { importance: 'low', temperature: 'hot', tags: ['auto-capture'], last_accessed: daysAgo(40) }));
  await createNote(MAIL_OLD, memory('mail old', { importance: 'low', temperature: 'cold', tags: ['matrimail'], last_accessed: daysAgo(45) }));
  await createNote(COLD_HOOK, memory('cold hook', { importance: 'medium', temperature: 'cold', tags: ['hook'], last_accessed: daysAgo(120) }));
  await createNote(COLD_UNIQUE, memory('cold unique', { importance: 'medium', temperature: 'cold', tags: ['insight'], last_accessed: daysAgo(120) }));
  await rebuildIndex();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function archivedFlag(p: string): Promise<boolean> {
  return parseFrontmatter((await readNote(p)).content).data.archived === true;
}

describe('autoArchiveColdMemories low-importance exhaust', () => {
  it('exposes auto-capture and matrimail as archive-safe exhaust tags', () => {
    expect(TEMPLATED_ARCHIVE_SAFE_TAGS.has('auto-capture')).toBe(true);
    expect(TEMPLATED_ARCHIVE_SAFE_TAGS.has('matrimail')).toBe(true);
    expect([...LOW_IMPORTANCE_ARCHIVE_TAGS].sort()).toEqual(['auto-capture', 'matrimail']);
  });

  it('archives importance=low auto-capture/matrimail notes after 30 days, keeps the rest on the 90-day cold clock', async () => {
    const result = await autoArchiveColdMemories(90, { lowImportanceDays: 30 });
    expect(result.archived.sort()).toEqual([COLD_HOOK, LOW_OLD, MAIL_OLD].sort());
    expect(result.archivedLowImportance).toBe(2);
    expect(result.skippedUnique).toBe(1);

    expect(await archivedFlag(LOW_OLD)).toBe(true);
    expect(await archivedFlag(MAIL_OLD)).toBe(true);
    expect(await archivedFlag(COLD_HOOK)).toBe(true);
    expect(await archivedFlag(LOW_FRESH)).toBe(false);   // < 30 d
    expect(await archivedFlag(MED_OLD)).toBe(false);     // medium: needs cold + 90 d
    expect(await archivedFlag(LOW_HOT)).toBe(false);     // hot is never archived
    expect(await archivedFlag(COLD_UNIQUE)).toBe(false); // unique content
  });

  it('is idempotent and honours the positional default', async () => {
    const again = await autoArchiveColdMemories();
    expect(again.archived).toEqual([]);
  });
});
