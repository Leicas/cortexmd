import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-orphan-triage-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-orphan-triage';
process.env.DASHBOARD_PASSWORD = 'test-orphan-triage';
process.env.ENABLE_EMBEDDINGS = 'false';

const { createNote } = await import('../vault.js');
const { rebuildIndex } = await import('../search.js');
const { buildAndCacheGraph } = await import('../graph.js');
const { stringifyFrontmatter, parseFrontmatter } = await import('../frontmatter.js');
const {
  isBoilerplateOnly, classifyOrphan, isProtectedPath, hasRecordData, runOrphanTriage,
} = await import('../orphan-triage.js');
const { runDreamCycle, DREAM_HYGIENE_LOCK } = await import('../dream-engine.js');
const { acquireOperation, releaseOperation } = await import('../operation-mutex.js');

const OLD = '2026-01-15';
const today = new Date().toISOString().slice(0, 10);

function note(data: Record<string, unknown>, body: string): string {
  return stringifyFrontmatter(data, body);
}
const file = (p: string): string => path.join(root, p);
const read = (p: string): string => readFileSync(file(p), 'utf-8');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('empty-note detection', () => {
  it('treats frontmatter + headings + template boilerplate as empty', () => {
    expect(isBoilerplateOnly('# Title\n\n## Notes\n\n- \n- [ ]\n---\n')).toBe(true);
    expect(isBoilerplateOnly('# {{title}}\n\nCreated: {{date}}\nStatus::\n**Owner:**\n<!-- fill me -->\n<% tp.date.now() %>\n')).toBe(true);
    expect(isBoilerplateOnly('')).toBe(true);
  });

  it('keeps a note with a single sentence, a link or a URL', () => {
    expect(isBoilerplateOnly('# Title\n\nThe deploy uses blue/green.\n')).toBe(false);
    expect(isBoilerplateOnly('# Title\n\n- [[Some note]]\n')).toBe(false);
    expect(isBoilerplateOnly('## [[Linked heading]]\n')).toBe(false);
    expect(isBoilerplateOnly('Ref: https://example.com/x\n')).toBe(false);
    expect(isBoilerplateOnly('- buy milk\n')).toBe(false);
  });

  it('never classifies record-type or record-data notes as empty', () => {
    expect(classifyOrphan('People/x.md', { type: 'person', title: 'X' }, '# X\n')).toEqual({ kind: 'skip', reason: 'record-data' });
    expect(classifyOrphan('Notes/x.md', { type: 'task', title: 'X' }, '')).toEqual({ kind: 'skip', reason: 'record-data' });
    expect(classifyOrphan('Notes/x.md', { title: 'X', email: 'a@example.com' }, '# X\n')).toEqual({ kind: 'skip', reason: 'record-data' });
    expect(classifyOrphan('Notes/x.md', { title: 'X', importance: 'high' }, '# X\n')).toEqual({ kind: 'skip', reason: 'record-data' });
    expect(classifyOrphan('Notes/x.md', { title: 'X', created: OLD, tags: [], temperature: 'cold' }, '# X\n')).toEqual({ kind: 'empty' });
    expect(hasRecordData({ title: 'X', aliases: [] })).toBe(false);
    expect(hasRecordData({ title: 'X', aliases: ['Y'] })).toBe(true);
  });

  it('classifies capture noise only when it is low-importance and prose-free', () => {
    expect(classifyOrphan('Memories/observation/a.md', { title: 'systemctl stop foo', category: 'observation' }, 'systemctl stop foo')).toMatchObject({ kind: 'noise' });
    expect(classifyOrphan('Memories/decision/a.md', { title: 'systemctl stop foo', category: 'decision' }, 'systemctl stop foo')).toEqual({ kind: 'valuable' });
    const prose = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    expect(classifyOrphan('Memories/observation/a.md', { title: 'systemctl stop foo' }, prose)).toEqual({ kind: 'valuable' });
  });

  it('protects index, template, project and diary paths', () => {
    for (const p of ['Indexes/a.md', 'Templates/t.md', 'Perso/templates/t.md', 'Notes/_templates/t.md',
      'Projects/alpha.md', 'Ops/Agent Diaries/x/2026-01-01.md', 'Journal/Journal Index.md', 'EmailLog/EmailLog Index.md']) {
      expect(isProtectedPath(p)).toBe(true);
    }
    expect(isProtectedPath('Notes/plain.md')).toBe(false);
    expect(isProtectedPath('Inbox/x.md', ['Inbox/'])).toBe(true);
  });
});

describe('orphan triage on a temp vault', () => {
  const EMPTY_A = 'Notes/empty-a.md';
  const EMPTY_B = 'Notes/empty-b.md';
  const YOUNG = 'Notes/empty-young.md';
  const TEMPLATE = 'Templates/meeting.md';
  const PERSON = 'People/someone.md';
  const CARD = 'Notes/contact-card.md';
  const SENTENCE = 'Notes/one-sentence.md';
  const NOISE = 'Memories/observation/systemctl-stop.md';
  const TAGGED = 'Memories/decision/alpha-db.md';
  const MENTION = 'Memories/insight/rocket-note.md';
  const UNHOMED = 'Memories/decision/use-postgres.md';
  const HUB_ALPHA = 'Projects/alpha.md';
  const HUB_ROCKET = 'Projects/gamma-rocket.md';

  beforeAll(async () => {
    await createNote(EMPTY_A, note({ title: 'Empty A', created: OLD, tags: [] }, '# Empty A\n\n## Notes\n\n- \n'));
    await createNote(EMPTY_B, note({ title: 'Empty B', created: OLD }, '# {{title}}\n\nStatus::\n'));
    await createNote(YOUNG, note({ title: 'Young', created: today }, '# Young\n'));
    await createNote(TEMPLATE, note({ title: 'Meeting', created: OLD }, '# Meeting\n\n## Agenda\n'));
    await createNote(PERSON, note({ type: 'person', title: 'Someone', created: OLD }, '# Someone\n'));
    await createNote(CARD, note({ title: 'Card', created: OLD, email: 'someone@example.com' }, '# Card\n'));
    await createNote(SENTENCE, note({ title: 'One sentence', created: OLD }, '# One sentence\n\nThe staging box reboots on Sundays.\n'));
    await createNote(NOISE, note({ type: 'memory', category: 'observation', title: 'systemctl stop foo.service', created: OLD }, 'systemctl stop foo.service\n'));
    await createNote(TAGGED, note({ type: 'memory', category: 'decision', title: 'Database choice', created: OLD, tags: ['alpha'] }, 'We picked SQLite for the first release.\n'));
    await createNote(MENTION, note({ type: 'memory', category: 'insight', title: 'Launch window', created: OLD }, 'The Gamma Rocket launch slips when the weather turns.\n'));
    await createNote(UNHOMED, note({ type: 'memory', category: 'decision', title: 'Use postgres for reporting', created: OLD }, 'Reporting moves to a dedicated database.\n'));
    await createNote(HUB_ALPHA, note({ type: 'project', title: 'Alpha' }, '# Alpha\n\nUser intro for the alpha project.\n'));
    await createNote(HUB_ROCKET, note({ type: 'project', title: 'Gamma Rocket' }, '# Gamma Rocket\n\nProject notes.\n'));
    await rebuildIndex();
    await buildAndCacheGraph();
  });

  it('dry-run reports the plan and writes nothing', async () => {
    const before = read(HUB_ALPHA);
    const r = await runOrphanTriage({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.deleted_empty.sort()).toEqual([EMPTY_A, EMPTY_B]);
    expect(r.archived_noise).toEqual([NOISE]);
    expect(r.linked).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: TAGGED, hub: HUB_ALPHA }),
      expect.objectContaining({ path: MENTION, hub: HUB_ROCKET, basis: 'title-mention' }),
      expect.objectContaining({ path: UNHOMED, hub: 'Indexes/Memories/Decision/2026-01.md', basis: 'type-index' }),
    ]));
    expect(existsSync(file(EMPTY_A))).toBe(true);
    expect(read(HUB_ALPHA)).toBe(before);
    expect(parseFrontmatter(read(NOISE)).data.archived).toBeUndefined();
    expect(existsSync(file('Indexes/Memories/Decision/2026-01.md'))).toBe(false);
  });

  it('respects per-action switches and caps', async () => {
    const r = await runOrphanTriage({ maxDelete: 1, archiveNoise: false, link: false });
    expect(r.deleted_empty).toEqual([EMPTY_A]);
    expect(r.skipped['delete-cap']).toBe(1);
    expect(r.skipped['archive-disabled']).toBe(1);
    expect(r.skipped['link-disabled']).toBeGreaterThanOrEqual(3);
    expect(existsSync(file(EMPTY_A))).toBe(false);
    expect(existsSync(file(EMPTY_B))).toBe(true);
    expect(parseFrontmatter(read(NOISE)).data.archived).toBeUndefined();
    // The deletion is journaled
    const journal = readFileSync(file(`Journal/${today.slice(0, 4)}/${today.slice(5, 7)}/${today}.md`), 'utf-8');
    expect(journal).toContain(`Deleted note: \`${EMPTY_A}\``);
  });

  it('deletes empty, archives noise, links valuable and leaves everything else', async () => {
    await buildAndCacheGraph();
    const r = await runOrphanTriage();
    expect(r.errors).toEqual([]);
    expect(r.deleted_empty).toEqual([EMPTY_B]);
    expect(r.archived_noise).toEqual([NOISE]);
    expect(existsSync(file(EMPTY_B))).toBe(false);
    for (const kept of [YOUNG, TEMPLATE, PERSON, CARD, SENTENCE, TAGGED, MENTION, UNHOMED]) {
      expect(existsSync(file(kept))).toBe(true);
    }
    const noise = parseFrontmatter(read(NOISE)).data;
    expect(noise.archived).toBe(true);
    expect(noise.archive_reason).toMatch(/capture noise/);

    const alpha = read(HUB_ALPHA);
    expect(alpha).toContain('User intro for the alpha project.');
    expect(alpha).toContain('## Related memories');
    expect(alpha).toContain('### Decisions');
    expect(alpha).toContain(`<!-- link:${TAGGED} -->`);
    expect(read(HUB_ROCKET)).toContain(`<!-- link:${MENTION} -->`);
    expect(read('Indexes/Memories/Decision/2026-01.md')).toContain('[[Memories/decision/use-postgres]]');
    expect(r.skipped['no-hub']).toBe(1); // the one-sentence note
    expect(r.skipped['too-young']).toBeGreaterThanOrEqual(1);
    expect(r.skipped['protected']).toBeGreaterThanOrEqual(1);
    expect(r.skipped['record-data']).toBe(2);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await buildAndCacheGraph();
    const alpha = read(HUB_ALPHA);
    const r = await runOrphanTriage();
    expect(r.deleted_empty).toEqual([]);
    expect(r.archived_noise).toEqual([]);
    expect(r.linked).toEqual([]);
    expect(read(HUB_ALPHA)).toBe(alpha);
  });

  it('dream report surfaces hygiene counts and the lock prevents overlap', async () => {
    const dry = await runDreamCycle({ dryRun: true, runLlm: false, reconcileProjects: false });
    expect(dry.hygiene).toMatchObject({ deleted_empty: 0, archived_noise: 0, linked: 0 });
    expect(dry.orphanTriage?.dryRun).toBe(true);

    expect(acquireOperation(DREAM_HYGIENE_LOCK)).toBe(true);
    try {
      const busy = await runDreamCycle({ dryRun: true, runLlm: false, reconcileProjects: false });
      expect(busy.hygiene.skipReason).toBe('already-running');
      expect(busy.orphanTriage).toBeUndefined();
    } finally {
      releaseOperation(DREAM_HYGIENE_LOCK);
    }
  });
});
