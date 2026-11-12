import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-store-api-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-store-api';
process.env.DASHBOARD_PASSWORD = 'test-store-api';
process.env.ENABLE_EMBEDDINGS = 'false';

const { storeMemoryFromApi, validateStoreMemoryBody, deriveTitle } = await import('../store-memory-api.js');
const { readNote } = await import('../vault.js');
const { rebuildIndex, getDocMeta } = await import('../search.js');
const { parseFrontmatter } = await import('../frontmatter.js');

beforeAll(async () => { await rebuildIndex(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const now = new Date();
const ym = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
const ymDash = ym.replace('/', '-');

async function frontmatterOf(p: string): Promise<Record<string, any>> {
  return parseFrontmatter((await readNote(p)).content).data;
}

describe('validateStoreMemoryBody', () => {
  it('rejects empty content, bad categories and bad importance with status 400', () => {
    expect(() => validateStoreMemoryBody({})).toThrow(expect.objectContaining({ status: 400, message: 'content required' }));
    expect(() => validateStoreMemoryBody({ content: 'x', category: 'nope' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => validateStoreMemoryBody({ content: 'x', importance: 'critical' })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('defaults category=observation, importance=low, source=hook', () => {
    expect(validateStoreMemoryBody({ content: ' hello ' })).toMatchObject({
      content: 'hello', category: 'observation', importance: 'low', source: 'hook', tags: [], skipDedupe: false,
    });
  });
});

describe('deriveTitle', () => {
  it('skips code fences and shell prompts like memory_store', () => {
    expect(deriveTitle('```sh\n$ git status\n```\nThe tree was clean. More.')).toBe('The tree was clean');
    expect(deriveTitle('$ echo hi')).toBe('echo hi');
  });
});

describe('storeMemoryFromApi', () => {
  it('drops capture noise (shell stubs and calendar invitations) without writing', async () => {
    const stub = await storeMemoryFromApi({ content: 'cortexmd: git add -A' });
    expect(stub).toMatchObject({ stored: false, reason: 'capture_noise' });
    expect(stub.pattern).toBeDefined();

    const invite = await storeMemoryFromApi({ content: 'Invitation: Standup @ Mon 10:00', category: 'observation' });
    expect(invite).toMatchObject({ stored: false, reason: 'capture_noise', title: 'Invitation: Standup @ Mon 10:00' });

    const updated = await storeMemoryFromApi({ title: 'Email - Updated invitation: Sync', content: 'moved to 11:00' });
    expect(updated).toMatchObject({ stored: false, reason: 'capture_noise' });
  });

  it('stores a machine (hook) capture born cold: low importance, heat 0, no source:* tag', async () => {
    const res = await storeMemoryFromApi({
      content: 'Build cache stale after dependency bump. The hook saw it on the second run.',
      tags: ['build'],
      source: 'posttooluse',
    });
    expect(res.stored).toBe(true);
    expect(res.category).toBe('observation');
    expect(res.title).toBe('Build cache stale after dependency bump');
    expect(res.path).toMatch(new RegExp(`^Memories/observation/${ym}/\\d{4}-\\d{2}-\\d{2}-build-cache-stale-after-dependency-bump-[0-9a-f]{8}\\.md$`));
    const fm = await frontmatterOf(res.path!);
    expect(fm).toMatchObject({
      type: 'memory', category: 'observation', importance: 'low', temperature: 'cold', heat_score: 0,
      source: 'posttooluse',
    });
    expect(fm.tags).toEqual(expect.arrayContaining(['build', 'auto-capture']));
    expect(fm.tags).not.toContain('source:posttooluse');
    expect(fm.memory_kind).toBe('episodic');
    expect(getDocMeta().get(res.path!)?.type).toBe('memory');
  });

  it('keeps the warm/6 start for a deliberate (non-machine) source', async () => {
    const res = await storeMemoryFromApi({
      content: 'Payment webhooks must be idempotent. Stripe retries for three days.',
      source: 'claude-code',
      importance: 'medium',
    });
    expect(res.stored).toBe(true);
    expect(await frontmatterOf(res.path!)).toMatchObject({ temperature: 'warm', heat_score: 6, importance: 'medium', access_count: 1, memory_kind: 'semantic' });
  });

  it('honours an explicit importance on a machine capture but still starts cold', async () => {
    const res = await storeMemoryFromApi({
      content: 'Contract renewal deadline moved to March. Legal confirmed by mail.',
      source: 'n8n:triage',
      importance: 'high',
    });
    expect(await frontmatterOf(res.path!)).toMatchObject({ temperature: 'cold', heat_score: 0, importance: 'high' });
  });

  it('drops hook echoes: bare commands, tool-result fragments, commit bodies, prompt fragments', async () => {
    expect(await storeMemoryFromApi({ content: 'kubectl get pods -n staging' })).toMatchObject({ stored: false, reason: 'capture_noise' });
    expect(await storeMemoryFromApi({ title: 'the parser returns early.</result>', content: 'x' })).toMatchObject({ stored: false, reason: 'capture_noise' });
    expect(await storeMemoryFromApi({ title: 'Release prep', content: 'Made a commit with message: "chore: bump"\nline two' }))
      .toMatchObject({ stored: false, reason: 'capture_noise', pattern: 'echo:git-commit-echo' });
    expect(await storeMemoryFromApi({ content: 'three widgets', source: 'hook:UserPromptSubmit' }))
      .toMatchObject({ stored: false, reason: 'capture_noise', pattern: 'echo:prompt-fragment' });
  });

  it('supersedes a recurring machine capture with the same title stem + source', async () => {
    const first = await storeMemoryFromApi({
      title: 'Morning ops briefing — Mon 2026-11-09',
      content: 'Two alerts overnight, both resolved.',
      source: 'n8n:briefing',
    });
    expect(first.stored).toBe(true);
    const second = await storeMemoryFromApi({
      title: 'Morning ops briefing — Tue 2026-11-10',
      content: 'Quiet night, one backup retried.',
      source: 'n8n:briefing',
    });
    expect(second).toMatchObject({ stored: true, supersededPath: first.path });
    const newFm = await frontmatterOf(second.path!);
    expect(newFm.supersedes).toBe(first.path);
    expect(newFm.valid_from).toBe(now.toISOString().slice(0, 10));
    const oldFm = await frontmatterOf(first.path!);
    expect(oldFm).toMatchObject({ superseded_by: second.path, archived: true, temperature: 'cold', heat_score: 0 });
    expect(oldFm.valid_to).toBe(now.toISOString().slice(0, 10));

    // A different source never supersedes (and a different stem stays separate).
    const other = await storeMemoryFromApi({
      title: 'Evening sales digest — Tue 2026-11-10',
      content: 'Three quotes sent.',
      source: 'n8n:sales',
    });
    expect(other.stored).toBe(true);
    expect(other.supersededPath).toBeUndefined();
  });

  it('honours importance from the body and keeps timeless categories flat', async () => {
    const res = await storeMemoryFromApi({
      content: 'The staging database lives in eu-west-1.',
      category: 'fact',
      importance: 'high',
    });
    expect(res.stored).toBe(true);
    expect(res.path).toMatch(/^Memories\/fact\/\d{4}-\d{2}-\d{2}-the-staging-database-lives-in-eu-west-1-[0-9a-f]{8}\.md$/);
    expect((await frontmatterOf(res.path!)).importance).toBe('high');
  });

  it('routes matrimail captures to EmailLog/ and links them from the monthly index', async () => {
    const res = await storeMemoryFromApi({
      title: 'Email - Quote request from Acme',
      content: 'Acme asks for a quote on 40 units.',
      tags: ['matrimail'],
      source: 'n8n',
    });
    expect(res.stored).toBe(true);
    expect(res.path).toBe(`EmailLog/observation/${ym}/${now.toISOString().slice(0, 10)}-email-quote-request-from-acme.md`);
    const index = await readNote(`EmailLog/EmailLog ${ymDash}.md`);
    expect(index.content).toContain(`[[${res.path!.replace(/\.md$/, '')}]]`);
    const top = await readNote('EmailLog/EmailLog Index.md');
    expect(top.content).toContain(`[[EmailLog/EmailLog ${ymDash}]]`);
    expect((await frontmatterOf(res.path!)).tags).toContain('matrimail');
  });

  it('reports a retried email capture as a duplicate instead of overwriting', async () => {
    const body = { title: 'Email - Invoice 1234 from Vendor', content: 'Invoice attached, due in 30 days.', tags: ['matrimail'], skipDedupe: true };
    const first = await storeMemoryFromApi(body);
    expect(first.stored).toBe(true);
    const again = await storeMemoryFromApi(body);
    expect(again).toMatchObject({ stored: false, reason: 'duplicate', existingPath: first.path });
  });

  it('dedups on a near-identical title in the same category', async () => {
    const first = await storeMemoryFromApi({
      content: 'Decided to use SQLite for the code index. It is embeddable and needs no daemon.',
      category: 'decision',
    });
    expect(first.stored).toBe(true);
    expect(first.title).toBe('Decided to use SQLite for the code index');
    // Same first sentence → same derived title → same slug → duplicate.
    const second = await storeMemoryFromApi({
      content: 'Decided to use SQLite for the code index. Revisited today, same conclusion.',
      category: 'decision',
    });
    expect(second).toMatchObject({ stored: false, reason: 'duplicate', existingPath: first.path });
    // A one-character slug drift ("indexes") is still the same memory.
    const drift = await storeMemoryFromApi({
      content: 'Decided to use SQLite for the code indexes. Same thing again.',
      category: 'decision',
    });
    expect(drift).toMatchObject({ stored: false, reason: 'duplicate' });

    const forced = await storeMemoryFromApi({
      content: 'Decided to use SQLite for the code index. Forced copy.',
      category: 'decision',
      skipDedupe: true,
    });
    expect(forced.stored).toBe(true);
    expect(forced.path).not.toBe(first.path);
  });
});
