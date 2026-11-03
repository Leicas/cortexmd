import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { config } from '../../config.js';
import { register } from '../../tools/worker-run.js';
import { registerCodeIngestRepo } from '../../tools/code-nav.js';
import { getCodeDb, closeCodeDb } from '../code-nav/db.js';

let temp: string | undefined;
let http: Server | undefined;
let client: Client | undefined;
let server: McpServer | undefined;
const original = { ...config };
afterEach(async () => {
  await client?.close();
  await server?.close();
  if (http) {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  closeCodeDb();
  if (temp) await rm(temp, { recursive: true, force: true });
  Object.assign(config, original);
});

it('investigates actual MCP-ingested code through a real HTTP provider without worker writes', async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'worker-mcp-smoke-'));
  const repo = path.join(temp, 'checkout');
  const brain = path.join(temp, 'brain');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(brain);
  const source = 'export function authenticate() { return false; }\n';
  await writeFile(path.join(repo, 'src/auth.ts'), source.replace(/\n/g, '\r\n'));
  const hash = createHash('sha1').update(source).digest('hex');
  const bodies: any[] = [];
  let attempts = 0;
  http = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      attempts++;
      let message: unknown;
      if (attempts === 1) {
        message = {
          content: null,
          tool_calls: [
            {
              id: 'search',
              type: 'function',
              function: {
                name: 'code_symbol_search',
                arguments: JSON.stringify({ query: 'authenticate' }),
              },
            },
          ],
        };
      } else if (attempts === 2) {
        const evidence = JSON.parse(body.messages.at(-1).content);
        message = {
          content: null,
          tool_calls: [
            {
              id: 'get',
              type: 'function',
              function: {
                name: 'code_symbol_get',
                arguments: JSON.stringify({ id: evidence.content.symbols[0].id }),
              },
            },
          ],
        };
      } else {
        message = {
          content: JSON.stringify({
            answer: 'authenticate returns false.',
            findings: [{ claim: 'authenticate returns false.', evidence_ids: ['e2'] }],
            limitations: [],
          }),
        };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: attempts < 3 ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      );
    } catch {
      res.statusCode = 500;
      res.end('fixture failure');
    }
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = (http.address() as import('node:net').AddressInfo).port;
  Object.assign(config, {
    dataDir: path.join(temp, 'data'),
    brainVault: brain,
    sourceVaults: [],
    sourceVaultConfigs: [],
    allVaults: [brain],
    workerEnabled: true,
    workerProvider: 'openai-compatible',
    workerEndpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    workerModel: 'fixture-small',
    workerApiKey: '',
  });
  server = new McpServer({ name: 'worker-smoke', version: '1' });
  registerCodeIngestRepo(server);
  register(server);
  client = new Client({ name: 'smoke-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const ingested = await client.callTool({
    name: 'code_ingest_repo',
    arguments: {
      repo_id: 'a'.repeat(16),
      slug: 'worker-smoke',
      git_origin: null,
      first_commit_sha: 'a'.repeat(40),
      machine_id: config.machineId,
      abs_path: repo,
      files: [
        {
          relative_path: 'src/auth.ts',
          language: 'typescript',
          content_hash: hash,
          size_bytes: Buffer.byteLength(source),
          symbols: [
            {
              id: 'b'.repeat(16),
              name: 'authenticate',
              kind: 'function',
              qualified_name: 'authenticate',
              signature: 'authenticate()',
              docstring: null,
              start_line: 1,
              end_line: 1,
              parent_id: null,
              content_hash: createHash('sha1').update(source.trim()).digest('hex'),
            },
          ],
          calls: [],
          imports: [],
        },
      ],
    },
  });
  expect(ingested.isError).not.toBe(true);
  const db = getCodeDb();
  const changesBefore = db.prepare('SELECT total_changes() AS n').get();
  const response = await client.callTool({
    name: 'worker_run',
    arguments: {
      task: 'Explain authenticate using exact source',
      repo: 'worker-smoke',
      paths: ['src'],
      budget: { maxToolCalls: 3 },
    },
  });
  expect(response.isError).not.toBe(true);
  const result = JSON.parse((response.content as Array<{ text: string }>)[0].text);
  expect(result).toMatchObject({
    status: 'complete',
    answer: 'authenticate returns false.',
    usage: {
      model: 'fixture-small',
      toolCalls: 2,
      rounds: 3,
      inputTokens: 300,
      outputTokens: 150,
      providerUsageComplete: true,
    },
  });
  expect(result.evidence[1]).toMatchObject({
    id: 'e2',
    tool: 'code_symbol_get',
    sources: [{ path: 'src/auth.ts', repo: 'worker-smoke', hash, startLine: 1, endLine: 1 }],
  });
  expect(result.evidence[1]).not.toHaveProperty('content');
  expect(JSON.stringify(bodies[2].messages)).toContain('export function authenticate()');
  expect(bodies[0].tools.map((t: any) => t.function.name)).toEqual([
    'code_symbol_search',
    'code_file_outline',
    'code_symbol_get',
    'code_symbol_callers',
    'code_symbol_callees',
  ]);
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changesBefore);
  expect(db.prepare('SELECT COUNT(*) AS n FROM index_requests').get()).toEqual({ n: 0 });
}, 20_000);
