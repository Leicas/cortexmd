import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// End-to-end memory_wakeup on a synthetic vault shaped like the live one:
// 8 machines with diaries, 5 recent lines of ~90 words from 3 projects.
// Asserts the output contract (3 diary lines, ≤60 words each, project
// section first, no "known agents" roster) and prints the before/after
// size so the sprint report can quote a measured number.

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-wakeup-size-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-wakeup-size';
process.env.DASHBOARD_PASSWORD = 'test-wakeup-size';
process.env.ENABLE_EMBEDDINGS = 'false';

const { createNote } = await import('../vault.js');
const { rebuildIndex } = await import('../search.js');
const { stringifyFrontmatter } = await import('../frontmatter.js');
const { register, trimDiaryLine } = await import('../../tools/memory-wakeup.js');
const { readAgentDiary, listAgentNames } = await import('../journal.js');

function toolHandler(reg: (server: McpServer) => void): (params: Record<string, unknown>, extra: unknown) => Promise<any> {
  let handler: ((params: Record<string, unknown>, extra: unknown) => Promise<any>) | undefined;
  reg({ tool: (_n: string, _d: unknown, _s: unknown, fn: typeof handler) => { handler = fn; } } as unknown as McpServer);
  if (!handler) throw new Error('tool handler was not registered');
  return handler;
}

const AGENT = 'Claude Code (Ao)';
const OTHER_AGENTS = ['Claude Code (nas)', 'Claude Code (laptop)', 'Codex (Ao)', 'Codex (laptop)', 'ChatGPT', 'Claude Code (build-box-01)', 'Claude Code (mac-mini)'];
const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ');

beforeAll(async () => {
  const lines = [
    ['09:00', `${words(90, 'homelab')} · [[Projects/homelab]] @ [[Machines/Ao]]`],
    ['10:00', `${words(90, 'crm')} · [[Projects/crm-sync]] @ [[Machines/Ao]]`],
    ['11:00', `${words(90, 'cortex')} · [[Projects/cortexmd]] @ [[Machines/Ao]]`],
    ['12:00', `${words(90, 'homelab')} · [[Projects/homelab]] @ [[Machines/Ao]]`],
    ['13:00', `${words(90, 'cortex')} · [[Projects/cortexmd]] @ [[Machines/Ao]]`],
    ['14:00', `${words(90, 'cortex')} · [[Projects/cortexmd]] @ [[Machines/Ao]]`],
  ];
  await createNote(`Ops/Agent Diaries/${AGENT}/2026-10-08.md`, `# ${AGENT} — 2026-10-08\n\n` + lines.map(([t, x]) => `- **${t}** — ${x}`).join('\n') + '\n');
  for (const a of OTHER_AGENTS) {
    await createNote(`Ops/Agent Diaries/${a}/2026-10-01.md`, `# ${a} — 2026-10-01\n\n- **09:00** — ${words(40, 'x')} · [[Projects/other]] @ [[Machines/${a}]]\n`);
  }
  await createNote('Projects/cortexmd.md', stringifyFrontmatter({ type: 'project', title: 'cortexmd', heat_score: 7, temperature: 'warm' }, '# cortexmd\n'));
  for (let i = 0; i < 6; i++) {
    await createNote(`Memories/decision/2026/10/d${i}.md`, stringifyFrontmatter({
      type: 'memory', category: 'decision', title: `decision ${i}`, heat_score: 10 - i, temperature: 'warm',
      related: ['[[Projects/cortexmd]]'],
    }, `# decision ${i}\n\nabout cortexmd\n`));
    await createNote(`Memories/observation/2026/10/o${i}.md`, stringifyFrontmatter({
      type: 'memory', category: 'observation', title: `obs ${i}`, heat_score: 16 - i, temperature: 'hot',
    }, `# obs ${i}\n\nunrelated\n`));
  }
  await rebuildIndex();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('memory_wakeup output contract', () => {
  it('trims diary lines to 60 words but keeps the project/machine links', () => {
    const line = `${words(90, 'w')} · [[Projects/cortexmd]] @ [[Machines/Ao]]`;
    const trimmed = trimDiaryLine(line);
    expect(trimmed.endsWith(' … · [[Projects/cortexmd]] @ [[Machines/Ao]]')).toBe(true);
    expect(trimmed.split(' · ')[0].split(/\s+/).length).toBe(61); // 60 words + ellipsis
    expect(trimDiaryLine('short line · [[Machines/Ao]]')).toBe('short line · [[Machines/Ao]]');
  });

  it('opens with this project, shows 3 project-filtered diary lines, and drops the agents roster', async () => {
    const handler = toolHandler(register);
    const after = await handler({ agentName: AGENT, preset: 'standard', project: 'cortexmd', machine: 'Ao' }, {});
    const text: string = after.content[0].text;

    expect(text).toContain('### this project — [[Projects/cortexmd]]');
    expect(text.indexOf('### this project')).toBeLessThan(text.indexOf('### memories'));
    expect(text).toContain(`### Agent Diary: ${AGENT} · [[Projects/cortexmd]]`);
    const diaryLines = text.split('\n').filter((l) => /^- \*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\*\* — /.test(l));
    expect(diaryLines).toHaveLength(3);
    for (const l of diaryLines) {
      expect(l).toContain('[[Projects/cortexmd]]');
      // "- **date time** —" is 4 tokens, then 60 words, then the ellipsis.
      expect(l.split(' · ')[0].split(/\s+/).length).toBeLessThanOrEqual(65);
    }
    expect(text).not.toContain('known agents');

    // "Before" = the pre-sprint rendering of the same vault: 5 unfiltered
    // full-length diary lines + the known-agents roster, no project section.
    const { entries } = await readAgentDiary(AGENT, 5);
    const agents = await listAgentNames();
    const beforeDiary = entries.map((e) => `- **${e.date} ${e.time}** — ${e.text}`).join('\n');
    const beforeFooter = ` · known agents: ${agents.join(', ')}`;
    const afterDiaryBlock = text.slice(text.indexOf('## Agent Diary'), text.lastIndexOf('\n\n---\n\n'));
    const beforeSize = text.length - afterDiaryBlock.length + beforeDiary.length + beforeFooter.length
      - (text.indexOf('### memories') - text.indexOf('### this project'));
    const afterSize = text.length;
    console.log(`wakeup sample size: before≈${beforeSize} chars (~${Math.ceil(beforeSize / 4)} tokens) → after=${afterSize} chars (~${Math.ceil(afterSize / 4)} tokens); diary block ${beforeDiary.length} → ${afterDiaryBlock.length} chars`);
    expect(afterSize).toBeLessThan(beforeSize);

    // Legacy call (no project): no project section, diary unfiltered but still capped at 3.
    const legacy = await handler({ agentName: AGENT, preset: 'standard' }, {});
    const ltext: string = legacy.content[0].text;
    expect(ltext).not.toContain('### this project');
    expect(ltext.split('\n').filter((l) => /^- \*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\*\* — /.test(l))).toHaveLength(3);
    expect(ltext).not.toContain('known agents');
  });
});
