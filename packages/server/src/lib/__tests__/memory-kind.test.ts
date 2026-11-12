import { describe, expect, it } from 'vitest';
import {
  memoryKindOf,
  resolveKindScope,
  kindInScope,
  isUnrestrictedScope,
  DEFAULT_RECALL_KINDS,
} from '../memory-kind.js';

describe('memoryKindOf — explicit value', () => {
  it('an explicit memory_kind wins over every other signal', () => {
    expect(memoryKindOf({ memory_kind: 'procedural', category: 'decision' }, 'EmailLog/x.md')).toBe('procedural');
    expect(memoryKindOf({ memory_kind: 'EPISODIC', category: 'fact' }, 'Memories/fact/x.md')).toBe('episodic');
  });

  it('an invalid explicit value is ignored', () => {
    expect(memoryKindOf({ memory_kind: 'bogus', category: 'decision' }, 'Memories/decision/x.md')).toBe('semantic');
  });
});

describe('memoryKindOf — episodic', () => {
  it.each([
    [{ type: 'memory', category: 'observation' }, 'EmailLog/observation/2026-11-01-hello.md'],
    [{ tags: ['matrimail'] }, 'Memories/observation/x.md'],
    [{ title: 'Email - Quarterly numbers' }, 'Memories/observation/x.md'],
    [{}, 'Ops/Agent Diaries/Claude Code (box)/2026-11-10.md'],
    [{ type: 'digest' }, 'Memories/observation/weekly.md'],
    [{ tags: ['consolidated-series'] }, 'Memories/observation/weekly.md'],
    [{}, 'Memories/consolidated/2026-W45.md'],
    [{ category: 'decision', source: 'hook:PostToolUse:Bash' }, 'Memories/decision/x.md'],
    [{ category: 'fact', source: 'n8n:triage' }, 'Memories/fact/x.md'],
    [{ category: 'observation', tags: ['trigger-capture'] }, 'Memories/observation/x.md'],
    [{ title: 'cortexmd: git add -A' }, 'Memories/observation/x.md'],
    [{ category: 'conversation' }, 'Memories/conversation/2026/11/x.md'],
    [{ type: 'diary' }, 'Notes/x.md'],
  ])('%j at %s → episodic', (fm, path) => {
    expect(memoryKindOf(fm as Record<string, unknown>, path)).toBe('episodic');
  });

  it('honours caller-supplied machine source patterns (replacing the defaults)', () => {
    expect(memoryKindOf({ category: 'fact', source: 'zapier' }, 'Memories/fact/x.md')).toBe('semantic');
    expect(memoryKindOf({ category: 'fact', source: 'zapier' }, 'Memories/fact/x.md', { machineSourcePatterns: ['^zapier'] })).toBe('episodic');
  });

  it('a deliberate source is not machine exhaust (even with the API auto-capture tag)', () => {
    expect(memoryKindOf({ category: 'decision', source: 'claude-code' }, 'Memories/decision/x.md')).toBe('semantic');
    expect(memoryKindOf({ category: 'fact', source: 'claude-code', tags: ['auto-capture'] }, 'Memories/fact/x.md')).toBe('semantic');
  });
});

describe('memoryKindOf — procedural', () => {
  it.each([
    [{ category: 'preference' }, 'Memories/preference/x.md'],
    [{ type: 'skill' }, 'Skills/deploy.md'],
    [{}, 'Skills/deploy.md'],
    [{ tags: ['#runbook'] }, 'Notes/restart.md'],
    [{ type: 'how-to' }, 'Notes/x.md'],
    [{ auto_extracted: true, preference_type: 'tool' }, 'Notes/x.md'],
  ])('%j at %s → procedural', (fm, path) => {
    expect(memoryKindOf(fm as Record<string, unknown>, path)).toBe('procedural');
  });
});

describe('memoryKindOf — semantic', () => {
  it.each([
    [{ category: 'decision' }, 'Memories/decision/2026/11/x.md'],
    [{ category: 'fact' }, 'Memories/fact/x.md'],
    [{ category: 'insight' }, 'Memories/insight/x.md'],
    [{ category: 'plan' }, 'Memories/plan/x.md'],
    [{ category: 'observation', source: 'claude-code' }, 'Memories/observation/x.md'],
    [{ type: 'person' }, 'People/Ada.md'],
    [{}, 'Projects/cortexmd.md'],
    [{}, 'Random/untyped.md'],
    [null, 'Random/untyped.md'],
  ])('%j at %s → semantic', (fm, path) => {
    expect(memoryKindOf(fm as Record<string, unknown> | null, path)).toBe('semantic');
  });

  it('normalises Windows separators and leading slashes', () => {
    expect(memoryKindOf({}, '\\EmailLog\\x.md')).toBe('episodic');
  });
});

describe('resolveKindScope / kindInScope', () => {
  it('defaults to semantic + procedural', () => {
    expect([...resolveKindScope()].sort()).toEqual([...DEFAULT_RECALL_KINDS].sort());
    expect(resolveKindScope({ includeEpisodic: false }).has('episodic')).toBe(false);
  });

  it('includeEpisodic adds episodic', () => {
    const s = resolveKindScope({ includeEpisodic: true });
    expect(isUnrestrictedScope(s)).toBe(true);
  });

  it('explicit kinds replace the default; invalid entries are ignored', () => {
    expect([...resolveKindScope({ kinds: ['episodic', 'nope'], includeEpisodic: false })]).toEqual(['episodic']);
    expect([...resolveKindScope({ kinds: ['nope'] })].sort()).toEqual(['procedural', 'semantic']);
  });

  it('kindInScope filters episodic notes out of the default scope', () => {
    const scope = resolveKindScope();
    expect(kindInScope({ category: 'decision' }, 'Memories/decision/x.md', scope)).toBe(true);
    expect(kindInScope({ type: 'memory' }, 'EmailLog/x.md', scope)).toBe(false);
    expect(kindInScope({ type: 'memory' }, 'EmailLog/x.md', resolveKindScope({ includeEpisodic: true }))).toBe(true);
  });
});
