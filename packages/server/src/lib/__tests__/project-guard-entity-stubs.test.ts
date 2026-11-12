import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-guard-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-guard';
process.env.DASHBOARD_PASSWORD = 'test-guard';
process.env.ENABLE_EMBEDDINGS = 'false';

const { createNote, readNote, writeNote } = await import('../vault.js');
const { stringifyFrontmatter, parseFrontmatter } = await import('../frontmatter.js');
const { rebuildIndex } = await import('../search.js');
const { checkProjectGuard, reconcileClusterIntoProject } = await import('../project-reconcile.js');
const { appendJournalEntry } = await import('../journal.js');

beforeAll(async () => {
  await createNote('Projects/demo-app.md', stringifyFrontmatter({ type: 'project', title: 'demo-app' }, '# demo-app\n'));
  await createNote('Projects/jane-doe.md', stringifyFrontmatter({ type: 'project', title: 'Jane Doe', auto_reconciled: true }, '# Jane Doe\n'));
  await createNote(
    'Ops/Agent Diaries/Agent (box1)/2026-11-01.md',
    '# Agent (box1) — 2026-11-01\n\n- **09:00** — shipped · [[Projects/diary-only]] @ [[Machines/box1]]\n',
  );
  await createNote('Memories/observation/a.md', stringifyFrontmatter({ type: 'memory', title: 'A', temperature: 'cold' }, '# A\nJane Doe called.\n'));
  await createNote('Memories/observation/b.md', stringifyFrontmatter({ type: 'memory', title: 'B', temperature: 'cold' }, '# B\nJane Doe again.\n'));
  await rebuildIndex();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('checkProjectGuard', () => {
  it('confirms curated project notes and diary-linked repo slugs', async () => {
    expect(await checkProjectGuard('demo-app')).toMatchObject({ ok: true, reason: 'project-note' });
    expect(await checkProjectGuard('Diary Only')).toMatchObject({ ok: true, slug: 'diary-only', reason: 'diary-slug' });
  });

  it('rejects people, filenames, tag pairs and dream-made projects', async () => {
    expect(await checkProjectGuard('Jane Doe')).toMatchObject({ ok: false, reason: 'auto-reconciled-only' });
    expect(await checkProjectGuard('Unknown Person')).toMatchObject({ ok: false, reason: 'unconfirmed' });
    expect(await checkProjectGuard('ops + infra', 'tags:ops+infra')).toMatchObject({ ok: false, reason: 'tag-pair' });
    expect(await checkProjectGuard('meeting-notes.md')).toMatchObject({ ok: false, reason: 'implausible-name' });
  });

  it('reconcileClusterIntoProject refuses an unconfirmed tie and writes nothing', async () => {
    const before = (await readNote('Projects/jane-doe.md')).content;
    const res = await reconcileClusterIntoProject({
      paths: ['Memories/observation/a.md', 'Memories/observation/b.md'],
      sharedTags: [], sharedEntities: ['Jane Doe'], basis: 'entity:Jane Doe', suggestedTitle: 'Jane Doe',
    });
    expect(res).toBeNull();
    expect((await readNote('Projects/jane-doe.md')).content).toBe(before);
    const people = await reconcileClusterIntoProject({
      paths: ['Memories/observation/a.md', 'Memories/observation/b.md'],
      sharedTags: [], sharedEntities: ['Someone Else'], basis: 'entity:Someone Else', suggestedTitle: 'Someone Else',
    });
    expect(people).toBeNull();
    await expect(readNote('Projects/someone-else.md')).rejects.toThrow();
  });

  it('still reconciles into a confirmed project', async () => {
    const res = await reconcileClusterIntoProject({
      paths: ['Memories/observation/a.md', 'Memories/observation/b.md'],
      sharedTags: [], sharedEntities: ['demo-app'], basis: 'entity:demo-app', suggestedTitle: 'demo-app',
    }, true);
    expect(res).toMatchObject({ projectPath: 'Projects/demo-app.md', created: false });
  });
});

describe('diary entity stubs', () => {
  it('creates Projects/<slug> and Machines/<host> stubs once and never overwrites', async () => {
    await appendJournalEntry('did a thing', undefined, 'Agent (box9)', { project: 'New Repo' });
    const proj = parseFrontmatter((await readNote('Projects/new-repo.md')).content);
    expect(proj.data).toMatchObject({ type: 'project', slug: 'new-repo', status: 'active', auto_stub: true });
    expect(proj.body).toContain('```dataview');
    const mach = parseFrontmatter((await readNote('Machines/box9.md')).content);
    expect(mach.data).toMatchObject({ type: 'machine', host: 'box9' });

    // A curated edit survives later diary writes.
    const { etag } = await readNote('Projects/new-repo.md');
    await writeNote('Projects/new-repo.md', stringifyFrontmatter({ type: 'project', title: 'New Repo' }, '# New Repo\nCurated.\n'), etag);
    await appendJournalEntry('did another thing', undefined, 'Agent (box9)', { project: 'new-repo' });
    expect((await readNote('Projects/new-repo.md')).content).toContain('Curated.');

    // An existing project note is never touched.
    const demoBefore = (await readNote('Projects/demo-app.md')).content;
    await appendJournalEntry('demo work', undefined, 'Agent (box9)', { project: 'demo-app' });
    expect((await readNote('Projects/demo-app.md')).content).toBe(demoBefore);
  });
});
