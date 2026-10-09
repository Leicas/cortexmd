import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory vault: journal.ts only needs readNote / writeNote / listFiles.
const store = new Map<string, string>();

vi.mock('../vault.js', () => ({
  readNote: async (path: string) => {
    const content = store.get(path);
    if (content === undefined) {
      const err: any = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    return { content, etag: `etag-${content.length}` };
  },
  writeNote: async (path: string, content: string) => {
    store.set(path, content);
    return { etag: `etag-${content.length}` };
  },
  listFiles: async (dir: string, _glob: string) =>
    [...store.keys()].filter((p) => p.startsWith(dir + '/')).sort(),
}));

const { readAgentDiary, diaryProjectMatcher } = await import('../journal.js');

const AGENT = 'Claude Code (Ao)';
const DIR = `Ops/Agent Diaries/${AGENT}`;

function day(date: string, lines: Array<[string, string]>): void {
  store.set(`${DIR}/${date}.md`, `# ${AGENT} — ${date}\n\n` + lines.map(([t, text]) => `- **${t}** — ${text}`).join('\n') + '\n');
}

beforeEach(() => store.clear());

describe('diaryProjectMatcher', () => {
  it('matches the [[Projects/<slug>]] suffix case-insensitively, with aliases and headings', () => {
    const re = diaryProjectMatcher('Cortex MD')!;
    expect(re.test('done · [[Projects/cortex-md]] @ [[Machines/Ao]]')).toBe(true);
    expect(re.test('done · [[projects/CORTEX-MD|alias]]')).toBe(true);
    expect(re.test('done · [[Projects/cortex-md#open]]')).toBe(true);
    expect(re.test('done · [[Projects/cortex-md-v2]]')).toBe(false);
    expect(re.test('done · [[Projects/other]]')).toBe(false);
  });

  it('returns null for an empty project', () => {
    expect(diaryProjectMatcher('   ')).toBeNull();
  });
});

describe('readAgentDiary with { project }', () => {
  it('returns only entries linking the project, chronologically, newest last', async () => {
    day('2026-10-01', [
      ['09:00', 'cortexmd A · [[Projects/cortexmd]] @ [[Machines/Ao]]'],
      ['10:00', 'other 1 · [[Projects/other]] @ [[Machines/Ao]]'],
    ]);
    day('2026-10-02', [
      ['09:00', 'cortexmd B · [[Projects/cortexmd]] @ [[Machines/Ao]]'],
      ['11:00', 'cortexmd C · [[Projects/cortexmd]] @ [[Machines/Ao]]'],
      ['12:00', 'cortexmd D · [[Projects/cortexmd]] @ [[Machines/Ao]]'],
      ['13:00', 'other 2 · [[Projects/other]] @ [[Machines/Ao]]'],
    ]);
    const { entries, total, projectFiltered } = await readAgentDiary(AGENT, 3, { project: 'cortexmd' });
    expect(projectFiltered).toBe(true);
    // `total` counts matches found before the early exit (the newest day
    // already yields 3), exactly like the unfiltered path always did.
    expect(total).toBe(3);
    expect(entries.map((e) => e.text.split(' ·')[0])).toEqual(['cortexmd B', 'cortexmd C', 'cortexmd D']);

    // Without lastN the whole diary is scanned and all 4 matches come back.
    const all = await readAgentDiary(AGENT, undefined, { project: 'cortexmd' });
    expect(all.projectFiltered).toBe(true);
    expect(all.total).toBe(4);
    expect(all.entries.every((e) => /\[\[Projects\/cortexmd\]\]/.test(e.text))).toBe(true);
  });

  it('falls back to the unfiltered diary when fewer than 2 entries match', async () => {
    day('2026-10-01', [
      ['09:00', 'other 1 · [[Projects/other]] @ [[Machines/Ao]]'],
      ['10:00', 'other 2 · [[Projects/other]] @ [[Machines/Ao]]'],
      ['11:00', 'new-repo once · [[Projects/new-repo]] @ [[Machines/Ao]]'],
    ]);
    const { entries, total, projectFiltered } = await readAgentDiary(AGENT, 3, { project: 'new-repo' });
    expect(projectFiltered).toBe(false);
    expect(total).toBe(3);
    expect(entries.map((e) => e.time)).toEqual(['09:00', '10:00', '11:00']);
  });

  it('with lastN returns the chronologically last N (not the first N of the newest day)', async () => {
    day('2026-10-01', [['09:00', 'old']]);
    day('2026-10-02', [['09:00', 'd2 first'], ['10:00', 'd2 second'], ['11:00', 'd2 third'], ['12:00', 'd2 fourth']]);
    const { entries } = await readAgentDiary(AGENT, 2);
    expect(entries.map((e) => e.text)).toEqual(['d2 third', 'd2 fourth']);
  });

  it('keeps the legacy shape without lastN (files newest-first, lines in file order)', async () => {
    day('2026-10-01', [['09:00', 'a'], ['10:00', 'b']]);
    day('2026-10-02', [['09:00', 'c']]);
    const { entries, total, projectFiltered } = await readAgentDiary(AGENT);
    expect(projectFiltered).toBe(false);
    expect(total).toBe(3);
    expect(entries.map((e) => e.text)).toEqual(['c', 'a', 'b']);
  });

  it('returns nothing for an unknown agent', async () => {
    expect(await readAgentDiary('nobody', 3, { project: 'cortexmd' })).toEqual({ entries: [], total: 0, projectFiltered: false });
  });
});
