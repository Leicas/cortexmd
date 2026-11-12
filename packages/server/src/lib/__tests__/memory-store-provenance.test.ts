import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = mkdtempSync(path.join(os.tmpdir(), 'cortexmd-store-prov-'));
process.env.BRAIN_VAULT = root;
process.env.DATA_DIR = path.join(root, 'data');
process.env.EMBEDDINGS_DATA_DIR = path.join(root, 'data', 'embeddings');
process.env.API_KEY = 'test-store-prov';
process.env.DASHBOARD_PASSWORD = 'test-store-prov';
process.env.ENABLE_EMBEDDINGS = 'false';
process.env.MEMORY_CONTRADICTION_DETECT = 'false';

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { register: registerMemoryStore } = await import('../../tools/memory-store.js');
const { storeMemoryFromApi, provenanceFrontmatter } = await import('../store-memory-api.js');
const { readNote } = await import('../vault.js');
const { rebuildIndex } = await import('../search.js');
const { parseFrontmatter } = await import('../frontmatter.js');
const { provenanceOf } = await import('../../dashboard/model/memories.js');

beforeAll(async () => { await rebuildIndex(); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function frontmatterOf(p: string): Promise<Record<string, any>> {
  return parseFrontmatter((await readNote(p)).content).data;
}

async function storeViaMcp(args: Record<string, unknown>): Promise<string> {
  const server = new McpServer({ name: 'cortexmd-test', version: '0.0.0' });
  registerMemoryStore(server);
  const client = new Client({ name: 'prov-test-client', version: '9.9.9' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = await client.callTool({ name: 'memory_store', arguments: { skipDedupe: true, ...args } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    const m = /→ (\S+\.md)/.exec(text);
    expect(m, text).toBeTruthy();
    return m![1];
  } finally {
    await client.close();
    await server.close();
  }
}

describe('provenanceFrontmatter', () => {
  it('keeps only non-blank one-line values and slugs the project', () => {
    expect(provenanceFrontmatter({})).toEqual({});
    expect(provenanceFrontmatter({ agent: '  ', machine: 3, project: 'My Repo!' })).toEqual({ project: 'my-repo' });
    expect(provenanceFrontmatter({ agent: 'Codex\n(box)', client: 'claude-code' })).toEqual({
      agent: 'Codex (box)',
      client: 'claude-code',
    });
  });
});

describe('memory_store provenance', () => {
  it('persists explicit agent/machine/project and the MCP client name', async () => {
    const p = await storeViaMcp({
      content: 'Decided to ship the wakeup REST route for hooks. It avoids an MCP handshake.',
      category: 'decision',
      agent: 'Claude Code (box)',
      machine: 'box',
      project: 'cortexmd',
    });
    const fm = await frontmatterOf(p);
    expect(fm).toMatchObject({ agent: 'Claude Code (box)', machine: 'box', project: 'cortexmd', client: 'prov-test-client' });
    expect(provenanceOf(fm)).toMatchObject({ agent: 'Claude Code (box)', machine: 'box', project: 'cortexmd' });
  });

  it('defaults agent to the MCP client name when omitted (backward compatible call)', async () => {
    const p = await storeViaMcp({ content: 'Observed that the plugin hook copies drift after hook edits.' });
    const fm = await frontmatterOf(p);
    expect(fm.agent).toBe('prov-test-client');
    expect(fm.client).toBe('prov-test-client');
    expect(fm).not.toHaveProperty('machine');
    expect(fm).not.toHaveProperty('project');
  });
});

describe('/api/store-memory provenance', () => {
  it('persists agent/machine/project from the body; omits them when absent', async () => {
    const res = await storeMemoryFromApi({
      content: 'Release flow needs a feat: subject on squash merges. Otherwise no release.',
      source: 'manual',
      agent: 'Codex (box)',
      machine: 'box',
      project: 'cortexmd',
    });
    expect(res.stored).toBe(true);
    expect(await frontmatterOf(res.path!)).toMatchObject({ agent: 'Codex (box)', machine: 'box', project: 'cortexmd' });

    const plain = await storeMemoryFromApi({ content: 'Dashboard inbox filters read frontmatter provenance keys.', source: 'manual' });
    const fm = await frontmatterOf(plain.path!);
    for (const k of ['agent', 'machine', 'project', 'client']) expect(fm).not.toHaveProperty(k);
  });
});
