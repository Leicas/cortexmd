import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-memory-design-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-memory-design';
process.env.DASHBOARD_PASSWORD = 'test-memory-design';
process.env.ENABLE_EMBEDDINGS = 'false';

const { createNote, readNote } = await import('../vault.js');
const { rebuildIndex, indexNote, getDocMeta, hybridSearch } = await import('../search.js');
const { distillCluster } = await import('../../tools/memory-consolidate.js');
const { buildAndCacheGraph, getNeighbors, updateGraphForNote } = await import('../graph.js');
const { parseFrontmatter, stringifyFrontmatter } = await import('../frontmatter.js');
const { register: registerSeries } = await import('../../tools/memory-consolidate-series.js');
const { register: registerEntities } = await import('../../tools/notes-link-entities.js');
const { register: registerStore } = await import('../../tools/memory-store.js');
const { register: registerRecall } = await import('../../tools/memory-recall.js');
const { decayMemories } = await import('../memory-lifecycle.js');
const { runDreamCycle } = await import('../dream-engine.js');

function toolHandler(register: (server: McpServer) => void): (params: Record<string, unknown>, extra: unknown) => Promise<any> {
  let handler: ((params: Record<string, unknown>, extra: unknown) => Promise<any>) | undefined;
  register({ tool: (_name: string, _description: unknown, _schema: unknown, fn: typeof handler) => {
    handler = fn;
  } } as unknown as McpServer);
  if (!handler) throw new Error('tool handler was not registered');
  return handler;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

function memory(title: string, body: string, extra: Record<string, unknown> = {}): string {
  return stringifyFrontmatter({ type: 'memory', category: 'fact', title, created: '2026-09-01', ...extra }, `# ${title}\n\n${body}\n`);
}

describe('memory lifecycle integration', () => {
  it('repairs a dangling inbound wiki link when its target is created', async () => {
    const sourcePath = 'Projects/link-source.md';
    const targetPath = 'People/late-target.md';
    await createNote(sourcePath, '# Source\n\n[[People/late-target]]');
    await buildAndCacheGraph();
    expect((await getNeighbors(sourcePath)).nodes).not.toContain(targetPath);
    const targetContent = '# Late target';
    await createNote(targetPath, targetContent);
    updateGraphForNote(targetPath, targetContent);
    expect((await getNeighbors(sourcePath)).nodes).toContain(targetPath);
  });

  it('keeps temporal validity through immediate single-note indexing', async () => {
    const notePath = 'Memories/fact/office.md';
    await createNote(notePath, memory('office', 'The office is in Building A.', {
      valid_from: '2026-01-01', valid_to: '2026-09-01', superseded_by: 'new-office.md',
    }));
    await rebuildIndex();
    await indexNote(notePath);
    expect(getDocMeta().get(notePath)?.valid_to).toBe('2026-09-01');
    expect((await hybridSearch('Building A', { type: 'memory', asOf: '2026-08-01' })).map((r) => r.path)).toContain(notePath);
    expect((await hybridSearch('Building A', { type: 'memory', asOf: '2026-09-02' })).map((r) => r.path)).not.toContain(notePath);
  });

  it('retrieves a memory among stronger nonmemory matches', async () => {
    const target = 'Memories/fact/rare-answer.md';
    await createNote(target, memory('needle memory', 'bronze hummingbird answer'));
    for (let i = 0; i < 35; i++) {
      await createNote(`Projects/distractor-${i}.md`, stringifyFrontmatter({ type: 'project', title: `bronze hummingbird ${i}` }, '# bronze hummingbird answer'));
    }
    await rebuildIndex();
    const found = await hybridSearch('bronze hummingbird', { type: 'memory', limit: 5 });
    expect(found.map((r) => r.path)).toContain(target);
  });

  it('keeps full sources and stable wiki links when distilling a same-day fact', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const first = `Memories/fact/${today}-same-title.md`;
    const second = `Memories/fact/${today}-same-title-2.md`;
    const fullBody = `Opening sentence. ${'Background context. '.repeat(20)} Hidden blue sapphire detail.`;
    await createNote(first, memory('Same title', fullBody));
    await createNote(second, memory('Same title 2', 'Corroborating source.'));
    await rebuildIndex();

    const result = await distillCluster({ category: 'fact', paths: [first, second] }, { dryRun: false });
    expect(result.errors).toEqual([]);
    expect(result.canonical).not.toBe(first);
    const canonical = await readNote(result.canonical);
    expect(canonical.content).toContain(`[[${first}]]`);
    const source = await readNote(first);
    expect(source.content).toContain(fullBody);
    expect(parseFrontmatter(source.content).data.consolidated_into).toBe(result.canonical);
    expect(parseFrontmatter(source.content).data.archived).toBe(true);
    expect(getDocMeta().get(first)?.consolidated_into).toBe(result.canonical);
    expect((await hybridSearch('Hidden blue sapphire detail', {
      type: 'memory', excludeArchived: false,
    })).map((r) => r.path)).toContain(first);

    const again = await distillCluster({ category: 'fact', paths: [first, second] }, { dryRun: false });
    expect(again.errors).toEqual([]);
    expect(again.canonical).toBe(result.canonical);
    expect((await readNote(result.canonical)).content).toBe(canonical.content);
    const recalled = await toolHandler(registerRecall)({ query: 'Hidden blue sapphire detail', limit: 5 }, {});
    const payload = JSON.parse(recalled.content[0].text.split('\n\n').at(-1));
    expect(payload.results.map((r: { path: string }) => r.path)).toContain(first);
  });

  it('archives weekly-series sources without deleting their linked originals', async () => {
    const sourcePath = 'Memories/observation/2026/09/series-evidence.md';
    await createNote(sourcePath, stringifyFrontmatter({
      type: 'memory', category: 'observation', title: 'Series evidence',
      created: '2026-09-01', tags: ['series-safety'],
    }, '# Series evidence\n\nFull historical observation that must remain.'));
    await rebuildIndex();
    const result = await toolHandler(registerSeries)({ tag: 'series-safety', keepLast: 0, dryRun: false }, {});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalArchived).toBe(1);
    const targetPath = parsed.results[0].targetPath as string;
    expect((await readNote(targetPath)).content).toContain(`[[${sourcePath}]]`);
    const source = await readNote(sourcePath);
    expect(source.content).toContain('Full historical observation that must remain.');
    expect(parseFrontmatter(source.content).data.consolidated_into).toBe(targetPath);
  });

  it('writes path-qualified wiki edges when linking entity notes', async () => {
    const person = 'Entities/people/Link Person.md';
    const org = 'Entities/orgs/Link Org.md';
    await createNote(person, '# Link Person');
    await createNote(org, '# Link Org');
    await rebuildIndex();
    const result = await toolHandler(registerEntities)({
      personPath: person, orgPath: org, evidence: ['Reviewed relationship'],
    }, {});
    expect(result.isError).toBeFalsy();
    expect((await readNote(person)).content).toContain(`[[${org}]]`);
    expect((await readNote(org)).content).toContain(`[[${person}]]`);
    expect((await getNeighbors(person)).nodes).toContain(org);
  });

  it('stores two explicitly distinct memories with the same title without overwrite', async () => {
    const handler = toolHandler(registerStore);
    const store = async (content: string): Promise<string> => {
      const result = await handler({ content, title: 'Shared title', category: 'observation', skipDedupe: true }, {});
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0].text.split('\n\n').at(-1));
      return payload.path as string;
    };
    const first = await store('The first independent observation has a blue marker.');
    const second = await store('The second independent observation has a red marker.');
    expect(first).not.toBe(second);
    expect((await readNote(first)).content).toContain('blue marker');
    expect((await readNote(second)).content).toContain('red marker');
  });

  it('decays by elapsed time rather than dream invocation count', async () => {
    const first = 'Memories/observation/2026/09/decay-a.md';
    const second = 'Memories/observation/2026/09/decay-b.md';
    const content = memory('decay observation', 'Stored fact with a heat score.', {
      category: 'observation', heat_score: 100, last_accessed: '2026-09-01',
      last_decayed: '2026-09-10T00:00:00.000Z',
    });
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));
      await createNote(first, content);
      await rebuildIndex();
      await decayMemories();
      vi.setSystemTime(new Date('2026-09-16T12:00:00.000Z'));
      await createNote(second, content);
      await indexNote(second);
      await decayMemories();
      const score = (p: string) => readNote(p).then(({ content: c }) => parseFrontmatter(c).data.heat_score);
      expect(await score(first)).toBe(await score(second));
      await decayMemories();
      expect(await score(first)).toBe(await score(second));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invoke synthesis during a dry dream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const report = await runDreamCycle({
        dryRun: true, runLlm: true, autoDecay: false, autoArchive: false,
        autoConsolidate: false, reconcileProjects: false,
      });
      expect(report.llm).toMatchObject({ ran: false, skipReason: 'dry-run' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
