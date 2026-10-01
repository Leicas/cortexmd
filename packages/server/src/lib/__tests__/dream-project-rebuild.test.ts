import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-project-rebuild-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-project-rebuild';
process.env.DASHBOARD_PASSWORD = 'test-project-rebuild';
process.env.ENABLE_EMBEDDINGS = 'false';

const { createNote } = await import('../vault.js');
const { rebuildIndex } = await import('../search.js');
const { stringifyFrontmatter, parseFrontmatter } = await import('../frontmatter.js');
const { runProjectRebuild, capFoldedBlocks } = await import('../project-rebuild.js');
const { parseHubBody, MANAGED_START, MANAGED_END } = await import('../hub-links.js');
const { reconcileClusterIntoProject } = await import('../project-reconcile.js');

const today = new Date().toISOString().slice(0, 10);
const file = (p: string): string => path.join(root, p);
const read = (p: string): string => readFileSync(file(p), 'utf-8');
const count = (s: string, needle: string): number => s.split(needle).length - 1;

afterAll(() => rmSync(root, { recursive: true, force: true }));

const HUB = 'Projects/beta.md';
const HUB_BODY = `# Beta

User intro text that must survive.

## Related memories
Hand-written note about the related list.
- [[Memories/missing-note]]
- [[Memories/fact/beta-1|Beta one]]
- [[Memories/fact/beta-1]]

## Consolidated memories

<!-- src:Memories/old/a.md -->
### A
_was Memories/old/a.md_

Body A.

<!-- src:Memories/old/b.md -->
### B
_was Memories/old/b.md_

Body B.

<!-- src:Memories/old/c.md -->
### C
_was Memories/old/c.md_

Body C links [[Nowhere/dangling]] and [[Memories/fact/beta-1]].

## Notes
User footer stays put.
`;

function mem(p: string, category: string, date: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return createNote(p, stringifyFrontmatter(
    { type: 'memory', category, title: path.basename(p, '.md'), created: date, ...extra },
    `Memory ${path.basename(p, '.md')} body.\n`,
  ));
}

describe('managed section parsing', () => {
  it('absorbs legacy link lines and keeps other user lines', () => {
    const parsed = parseHubBody(HUB_BODY);
    expect(parsed.hasSection).toBe(true);
    expect(parsed.preserved).toEqual(['Hand-written note about the related list.']);
    expect(parsed.entryRefs.map((r) => r.ref)).toEqual(['Memories/missing-note', 'Memories/fact/beta-1', 'Memories/fact/beta-1']);
    expect(parsed.before).toContain('User intro text');
    expect(parsed.after.startsWith('## Consolidated memories')).toBe(true);
  });

  it('caps folded blocks, keeping the newest (top) ones', () => {
    const { body, moved } = capFoldedBlocks(HUB_BODY, 1);
    expect(moved).toHaveLength(2);
    expect(body).toContain('Body A.');
    expect(body).not.toContain('Body B.');
    expect(body).toContain('## Notes\nUser footer stays put.');
  });
});

describe('project rebuild on a temp vault', () => {
  beforeAll(async () => {
    await createNote(HUB, stringifyFrontmatter({ type: 'project', title: 'Beta', related: ['[[Memories/fact/beta-1]]', '[[Gone/away]]'] }, HUB_BODY));
    await mem('Memories/fact/beta-1.md', 'fact', '2026-09-20', { tags: ['beta'] });
    await mem('Memories/decision/beta-2.md', 'decision', '2026-09-10', { project: '[[Projects/beta]]' });
    await mem('Memories/preference/beta-3.md', 'preference', '2026-08-05', { tags: ['project/beta'] });
    await mem('Memories/observation/beta-4.md', 'observation', '2026-08-01', { tags: ['beta'] });
    await mem('Memories/observation/beta-archived.md', 'observation', '2026-08-01', { tags: ['beta'], archived: true });
    await mem('Memories/observation/unrelated.md', 'observation', '2026-08-01', { tags: ['other'] });
    await rebuildIndex();
  });

  it('dry-run reports without writing', async () => {
    const before = read(HUB);
    const r = await runProjectRebuild({ dryRun: true, maxLinks: 2, foldCap: 1 });
    expect(r.projects_rebuilt.map((p) => p.path)).toEqual([HUB]);
    expect(read(HUB)).toBe(before);
    expect(existsSync(file(`Projects/Archive/beta-folded-${today}.md`))).toBe(false);
  });

  it('rebuilds the managed section, preserves user text and caps size', async () => {
    const r = await runProjectRebuild({ maxLinks: 2, foldCap: 1 });
    expect(r.errors).toEqual([]);
    expect(r.projects_rebuilt).toHaveLength(1);
    expect(r.projects_rebuilt[0]).toMatchObject({ listed: 2, overflow: 2 });

    const hub = read(HUB);
    const { data, body } = parseFrontmatter(hub);
    // User text outside the managed block is preserved verbatim
    expect(body).toContain('# Beta\n\nUser intro text that must survive.');
    expect(body).toContain('Hand-written note about the related list.');
    expect(body).toContain('## Notes\nUser footer stays put.');
    // Managed block: deduped, dangling + archived + unrelated dropped
    expect(count(body, MANAGED_START)).toBe(1);
    expect(count(body, MANAGED_END)).toBe(1);
    expect(body).not.toContain('missing-note');
    expect(body).not.toContain('beta-archived');
    expect(body).not.toContain('unrelated');
    expect(count(body, '<!-- link:')).toBe(2);
    expect(body).toContain('<!-- link:Memories/fact/beta-1.md -->');
    expect(body).toContain('<!-- link:Memories/decision/beta-2.md -->');
    expect(body).toContain('### Decisions');
    // Overflow goes to a generated monthly index linked from the hub
    expect(body).toContain('### Older memories');
    expect(body).toContain('<!-- index:Indexes/Projects/beta/2026-08.md -->');
    const idx = read('Indexes/Projects/beta/2026-08.md');
    expect(parseFrontmatter(idx).data.generated).toBe('dream-project-index');
    expect(idx).toContain('<!-- link:Memories/preference/beta-3.md -->');
    expect(idx).toContain('<!-- link:Memories/observation/beta-4.md -->');
    // Folded overflow moved to a dated archive note, dangling links flattened
    const archivePath = `Projects/Archive/beta-folded-${today}.md`;
    expect(body).toContain(`<!-- fold-archive:${archivePath} -->`);
    expect(body).toContain('Body A.');
    expect(body).not.toContain('Body B.');
    const archive = read(archivePath);
    expect(archive).toContain('Body B.');
    expect(archive).toContain('Body C links dangling and');
    expect(archive).not.toContain('[[Nowhere/dangling]]');
    expect(archive).toContain('[[Memories/fact/beta-1]]');
    // Dangling frontmatter `related` pruned
    expect(data.related).toEqual(['[[Memories/fact/beta-1]]']);
  });

  it('is idempotent', async () => {
    await rebuildIndex();
    const hub = read(HUB);
    const idx = read('Indexes/Projects/beta/2026-08.md');
    const r = await runProjectRebuild({ maxLinks: 2, foldCap: 1 });
    expect(r.projects_rebuilt).toEqual([]);
    expect(read(HUB)).toBe(hub);
    expect(read('Indexes/Projects/beta/2026-08.md')).toBe(idx);
  });

  it('respects the per-run rebuild cap', async () => {
    await createNote('Projects/gamma.md', stringifyFrontmatter({ type: 'project', title: 'Gamma' }, '# Gamma\n'));
    await createNote('Projects/delta.md', stringifyFrontmatter({ type: 'project', title: 'Delta' }, '# Delta\n'));
    await mem('Memories/fact/gamma-1.md', 'fact', '2026-09-01', { tags: ['gamma'] });
    await mem('Memories/fact/delta-1.md', 'fact', '2026-09-01', { tags: ['delta'] });
    await rebuildIndex();
    const r = await runProjectRebuild({ maxRebuilds: 1, maxLinks: 2, foldCap: 1 });
    expect(r.projects_rebuilt.map((p) => p.path)).toEqual(['Projects/delta.md']);
    expect(read('Projects/gamma.md')).toBe(stringifyFrontmatter({ type: 'project', title: 'Gamma' }, '# Gamma\n'));
  });

  it('project-reconcile links through the capped managed section, idempotently', async () => {
    const cluster = {
      paths: ['Memories/observation/unrelated.md', 'Memories/fact/gamma-1.md'],
      sharedTags: [], sharedEntities: ['Epsilon'], basis: 'entity:Epsilon', suggestedTitle: 'Epsilon',
    };
    const first = await reconcileClusterIntoProject(cluster);
    expect(first).toMatchObject({ projectPath: 'Projects/epsilon.md', created: true });
    const hub = read('Projects/epsilon.md');
    expect(count(hub, MANAGED_START)).toBe(1);
    expect(hub).toContain('<!-- link:Memories/fact/gamma-1.md -->');
    expect(await reconcileClusterIntoProject(cluster)).toBeNull();
    expect(read('Projects/epsilon.md')).toBe(hub);
  });
});
