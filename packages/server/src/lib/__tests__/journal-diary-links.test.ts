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

const {
  appendJournalEntry,
  readAgentDiary,
  renderDiaryLinks,
  machineFromAgentName,
  projectSlug,
} = await import('../journal.js');

const AGENT = 'Claude Code (Ao)';

function lastLine(path: string): string {
  const content = store.get(path) ?? '';
  const lines = content.trimEnd().split('\n');
  return lines[lines.length - 1];
}

beforeEach(() => store.clear());

describe('machineFromAgentName', () => {
  it('extracts the trailing parenthesised host', () => {
    expect(machineFromAgentName('Claude Code (Ao)')).toBe('Ao');
    expect(machineFromAgentName('Codex (build-box-01)')).toBe('build-box-01');
  });

  it('returns empty when there is no host segment', () => {
    expect(machineFromAgentName('claude')).toBe('');
    expect(machineFromAgentName('Claude (x) Code')).toBe('');
  });

  it('strips wiki-link-breaking characters', () => {
    expect(machineFromAgentName('Agent (a[b]|c#d^e)')).toBe('abcde');
  });
});

describe('projectSlug', () => {
  it('matches the Projects/<slug>.md rule', () => {
    expect(projectSlug('cortexmd')).toBe('cortexmd');
    expect(projectSlug('Cortex MD / v2')).toBe('cortex-md-v2');
    expect(projectSlug('--weird--')).toBe('weird');
  });
});

describe('renderDiaryLinks', () => {
  it('renders project @ machine', () => {
    expect(renderDiaryLinks('recap', AGENT, { project: 'cortexmd', machine: 'Ao' })).toBe(
      ' · [[Projects/cortexmd]] @ [[Machines/Ao]]',
    );
  });

  it('derives the machine from the agent name when omitted', () => {
    expect(renderDiaryLinks('recap', AGENT, { project: 'cortexmd' })).toBe(
      ' · [[Projects/cortexmd]] @ [[Machines/Ao]]',
    );
  });

  it('renders the machine alone when no project is known', () => {
    expect(renderDiaryLinks('recap', AGENT)).toBe(' · [[Machines/Ao]]');
  });

  it('renders nothing for a plain agent with no links', () => {
    expect(renderDiaryLinks('recap', 'claude')).toBe('');
  });

  it('slugifies the project and sanitizes the machine', () => {
    expect(renderDiaryLinks('x', 'claude', { project: 'My Repo', machine: 'host[1]|#' })).toBe(
      ' · [[Projects/my-repo]] @ [[Machines/host1]]',
    );
  });

  it('does not repeat links the entry already carries', () => {
    const entry = 'done · [[Projects/cortexmd]] @ [[Machines/Ao]]';
    expect(renderDiaryLinks(entry, AGENT, { project: 'cortexmd', machine: 'Ao' })).toBe('');
    // Partial: only the missing side is appended.
    expect(renderDiaryLinks('see [[Projects/cortexmd]]', AGENT, { project: 'cortexmd' })).toBe(
      ' · [[Machines/Ao]]',
    );
  });
});

describe('appendJournalEntry (diary) with links', () => {
  it('suffixes the entry line with project and machine links', async () => {
    const { path } = await appendJournalEntry('shipped the thing', undefined, AGENT, {
      project: 'cortexmd',
      machine: 'Ao',
    });
    expect(path).toMatch(/^Ops\/Agent Diaries\/Claude Code \(Ao\)\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(lastLine(path)).toMatch(
      /^- \*\*\d{2}:\d{2}\*\* — shipped the thing · \[\[Projects\/cortexmd\]\] @ \[\[Machines\/Ao\]\]$/,
    );
  });

  it('falls back to the agent-name host when machine is omitted', async () => {
    const { path } = await appendJournalEntry('recap', undefined, AGENT, { project: 'cortexmd' });
    expect(lastLine(path)).toContain('· [[Projects/cortexmd]] @ [[Machines/Ao]]');
  });

  it('leaves legacy callers (no links) byte-compatible apart from the machine link', async () => {
    const { path } = await appendJournalEntry('plain', undefined, 'claude');
    expect(lastLine(path)).toMatch(/^- \*\*\d{2}:\d{2}\*\* — plain$/);
  });

  it('readAgentDiary still parses entries that carry links', async () => {
    await appendJournalEntry('first', undefined, AGENT, { project: 'cortexmd' });
    await appendJournalEntry('second', undefined, AGENT, { project: 'cortexmd', machine: 'Ao' });
    const { entries, total } = await readAgentDiary(AGENT);
    expect(total).toBe(2);
    expect(entries.map((e) => e.text)).toEqual([
      'first · [[Projects/cortexmd]] @ [[Machines/Ao]]',
      'second · [[Projects/cortexmd]] @ [[Machines/Ao]]',
    ]);
    expect(entries[0].time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('folds a multi-line entry into one line that readAgentDiary reads back in full', async () => {
    const entry = 'outcome: shipped\n\nopen: tests\r\n  files: a.ts, b.ts';
    const { path } = await appendJournalEntry(entry, undefined, AGENT, { project: 'cortexmd' });
    const content = store.get(path) ?? '';
    // Exactly one entry line was written (header + blank + entry).
    expect(content.trimEnd().split('\n').filter((l) => l.startsWith('- **')).length).toBe(1);
    const { entries } = await readAgentDiary(AGENT);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe(
      'outcome: shipped / open: tests / files: a.ts, b.ts · [[Projects/cortexmd]] @ [[Machines/Ao]]',
    );
  });

  it('does not touch the daily journal format', async () => {
    const { path } = await appendJournalEntry('ops line', { kind: 'tool', id: 'x' }, undefined, {
      project: 'cortexmd',
      machine: 'Ao',
    });
    expect(path).toMatch(/^Journal\//);
    expect(lastLine(path)).toMatch(/^- \[\d{2}:\d{2}:\d{2}\] ops line \(source: tool x\)$/);
    expect(lastLine(path)).not.toContain('[[Projects/');
  });
});
