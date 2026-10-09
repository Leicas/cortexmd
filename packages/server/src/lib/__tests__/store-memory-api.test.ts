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

  it('stores an observation under Memories/ with low importance, warm, heat 6 and auto-capture tags', async () => {
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
      type: 'memory', category: 'observation', importance: 'low', temperature: 'warm', heat_score: 6,
      access_count: 1, source: 'posttooluse',
    });
    expect(fm.tags).toEqual(expect.arrayContaining(['build', 'auto-capture', 'source:posttooluse']));
    expect(getDocMeta().get(res.path!)?.type).toBe('memory');
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
