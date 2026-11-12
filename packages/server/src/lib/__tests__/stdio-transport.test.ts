import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Spawns the real entry point (`src/index.ts --stdio` via tsx) against a temp
// vault and drives it with the SDK stdio client: initialize → tools/list →
// read-only tool calls. Any non-JSON line on stdout would surface as a
// transport error, so a clean run also proves logs go to stderr.
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let temp: string;
let client: Client;
let transport: StdioClientTransport;
const transportErrors: Error[] = [];
let stderr = '';

beforeAll(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'cortexmd-stdio-'));
  const vault = path.join(temp, 'brain');
  await mkdir(path.join(vault, 'Projects'), { recursive: true });
  await writeFile(
    path.join(vault, 'Projects', 'quokka.md'),
    '---\ntitle: Quokka migration plan\ntype: project\n---\n\nThe quokkaflux pipeline moves to the new cluster in March.\n',
  );

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, {
    BRAIN_VAULT: vault,
    DATA_DIR: path.join(temp, 'data'),
    EMBEDDINGS_DATA_DIR: path.join(temp, 'data', 'embeddings'),
    ENABLE_EMBEDDINGS: 'false',
    ENABLE_KG: 'false',
    API_KEY: 'stdio-test',
    DASHBOARD_PASSWORD: 'stdio-test',
    TOOL_PROFILE: 'chatgpt',
    CODE_REPOS: '',
    LOG_LEVEL: 'info',
  });
  delete env.CORTEXMD_NO_AUTOSTART;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts', '--stdio'],
    cwd: serverRoot,
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  transport.onerror = (err) => transportErrors.push(err);
  client = new Client({ name: 'stdio-test', version: '0.0.0' });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
});

function text(res: unknown): string {
  return ((res as { content: Array<{ text: string }> }).content[0]?.text) ?? '';
}

describe('stdio transport (node dist/index.js --stdio)', () => {
  it('initializes and lists the profile tools', async () => {
    expect(client.getServerVersion()?.name).toBe('cortexmd');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('memory_recall');
    expect(names).toContain('tool_invoke');
    expect(names).toContain('search');
    expect(names).toContain('fetch');
    expect(names).not.toContain('kg_add'); // hidden by the profile
  });

  it('serves read-only tool calls against the vault (search → fetch, notes_get)', async () => {
    const search = await client.callTool({ name: 'search', arguments: { query: 'quokkaflux pipeline' } });
    expect(search.isError).toBeFalsy();
    const { results } = JSON.parse(text(search)) as { results: Array<{ id: string; title: string; url: string }> };
    const hit = results.find((r) => r.id === 'Projects/quokka.md');
    expect(hit, text(search)).toBeTruthy();
    expect(hit!.title).toBe('Quokka migration plan');
    expect(hit!.url).toMatch(/^obsidian:\/\/open\?/);

    const fetched = await client.callTool({ name: 'fetch', arguments: { id: hit!.id } });
    expect(fetched.isError).toBeFalsy();
    const doc = JSON.parse(text(fetched)) as { id: string; title: string; text: string };
    expect(doc.id).toBe('Projects/quokka.md');
    expect(doc.text).toContain('quokkaflux');

    const note = await client.callTool({ name: 'notes_get', arguments: { path: 'Projects/quokka.md' } });
    expect(note.isError).toBeFalsy();
    expect(text(note)).toContain('quokkaflux');
  });

  it('keeps stdout JSON-RPC only (logs go to stderr)', () => {
    expect(transportErrors).toEqual([]);
    expect(stderr).toContain('stdio transport ready');
  });
});
