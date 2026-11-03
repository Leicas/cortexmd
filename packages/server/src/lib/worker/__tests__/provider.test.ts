import { describe, expect, it, vi } from 'vitest';
import { createCompatibleProvider } from '../provider.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runWorker } from '../runtime.js';

const request = {
  messages: [{ role: 'user' as const, content: 'Find handler' }],
  tools: [{ name: 'code_symbol_search', description: 'Search', parameters: { type: 'object' } }],
  maxOutputTokens: 500,
  signal: new AbortController().signal,
};
const response = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'code_symbol_search', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 10 },
};

describe('compatible worker provider', () => {
  it('runs a complete tool investigation through a real HTTP endpoint', async () => {
    const received: any[] = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push(body);
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          received.length === 1
            ? response
            : {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        answer: 'Handler found',
                        findings: [{ claim: 'Auth handler exists', evidence_ids: ['e1'] }],
                        limitations: [],
                      }),
                    },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 50, completion_tokens: 30 },
              },
        ),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const port = (server.address() as import('node:net').AddressInfo).port;
      const provider = createCompatibleProvider({
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
        model: 'test-small',
      });
      const result = await runWorker(
        { task: 'Find auth handler', mode: 'code-investigator' },
        {
          provider,
          tools: request.tools,
          executeTool: async () => ({
            content: 'export function auth() {}',
            sources: [{ path: 'src/auth.ts', hash: 'abc' }],
          }),
        },
      );
      expect(result.status).toBe('complete');
      expect(result.findings[0].evidence_ids).toEqual(['e1']);
      expect(received).toHaveLength(2);
      expect(received[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
      expect(JSON.stringify(result)).not.toContain('export function auth');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('sends configured model, tools and budgets and parses calls and usage', async () => {
    const fetcher = vi.fn(async () => Response.json(response));
    const provider = createCompatibleProvider({
      endpoint: 'https://example.test/v1/chat/completions',
      model: 'small',
      apiKey: 'secret',
      fetch: fetcher as typeof fetch,
    });
    const result = await provider.complete(request);
    expect(result.toolCalls?.[0].function.name).toBe('code_symbol_search');
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    const init = (fetcher.mock.calls as any)[0][1];
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'small',
      max_tokens: 500,
      parallel_tool_calls: false,
    });
  });
  it('does not echo upstream error bodies', async () => {
    const provider = createCompatibleProvider({
      endpoint: 'https://example.test',
      model: 'small',
      fetch: (async () => new Response('secret', { status: 401 })) as typeof fetch,
    });
    await expect(provider.complete(request)).rejects.toThrow('HTTP 401');
  });
  it('caps response bytes', async () => {
    const provider = createCompatibleProvider({
      endpoint: 'https://example.test',
      model: 'small',
      maxResponseBytes: 10,
      fetch: (async () => Response.json(response)) as typeof fetch,
    });
    await expect(provider.complete(request)).rejects.toThrow('exceeds limit');
  });
  it('rejects malformed tool calls', async () => {
    const provider = createCompatibleProvider({
      endpoint: 'https://example.test',
      model: 'small',
      fetch: (async () =>
        Response.json({
          choices: [{ message: { content: null, tool_calls: [{}] } }],
        })) as typeof fetch,
    });
    await expect(provider.complete(request)).rejects.toThrow('invalid completion');
  });
  it('rejects credential-bearing URLs', () => {
    expect(() =>
      createCompatibleProvider({ endpoint: 'https://user:secret@example.test', model: 'small' }),
    ).toThrow();
  });
});
