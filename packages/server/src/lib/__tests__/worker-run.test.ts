import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const mocks = vi.hoisted(() => ({
  provider: vi.fn(() => ({ model: 'small' })),
  run: vi.fn(),
  tools: vi.fn(() => ({ tools: [], executeTool: vi.fn() })),
}));
vi.mock('../worker/index.js', () => ({
  createCompatibleProvider: mocks.provider,
  runWorker: mocks.run,
  WorkerSemaphore: class {},
}));
vi.mock('../worker-tools.js', () => ({ createWorkerTools: mocks.tools }));
vi.mock('../tool-wrapper.js', () => ({
  wrapToolHandler: (_name: string, fn: () => unknown) => fn,
}));
import { register, workerRunSchema } from '../../tools/worker-run.js';
import { config } from '../../config.js';
let handler: (args: unknown, extra: { signal: AbortSignal }) => Promise<any>;
const extra = { signal: new AbortController().signal };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(config, {
    workerEnabled: true,
    workerProvider: 'openai-compatible',
    workerEndpoint: 'http://localhost:9999/v1/chat/completions',
    workerModel: 'small',
    workerApiKey: 'secret',
  });
  mocks.run.mockResolvedValue({ status: 'complete', usage: { toolCalls: 1, durationMs: 2 } });
  register({
    tool: (_n: unknown, _d: unknown, _s: unknown, fn: typeof handler) => {
      handler = fn;
    },
  } as unknown as McpServer);
});
describe('worker_run boundary', () => {
  it('fails closed before constructing provider when disabled', async () => {
    Object.assign(config, { workerEnabled: false });
    await expect(handler({ task: 'investigate', repo: 'one' }, extra)).rejects.toThrow('disabled');
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('requires explicitly configured provider and model', async () => {
    Object.assign(config, { workerProvider: '' });
    await expect(handler({ task: 'investigate', repo: 'one' }, extra)).rejects.toThrow(
      'explicitly configured',
    );
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it.each([
    { task: 'inspect', repo: 'one', endpoint: 'http://evil' },
    { task: 'inspect', repo: 'one', apiKey: 'mine' },
    { task: 'inspect', repo: 'one', model: 'large' },
    { task: 'inspect', repo: 'one', budget: { maxToolCalls: 0 } },
    { task: 'inspect', repo: 'one', budget: { maxToolCalls: NaN } },
  ])('rejects configuration injection and malformed budgets', (args) =>
    expect(() => workerRunSchema.parse(args)).toThrow(),
  );
  it('rejects ambiguous scope combinations before invoking model', async () => {
    for (const args of [
      { task: 'inspect' },
      { task: 'inspect', repo: 'one', note_paths: ['Projects'] },
      { task: 'inspect', mode: 'knowledge-investigator' },
      { task: 'inspect', mode: 'knowledge-investigator', repo: 'one', note_paths: ['Projects'] },
    ])
      await expect(handler(args, extra)).rejects.toThrow();
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it('passes request cancellation, bounded scope and server caps to runtime', async () => {
    await handler(
      { task: 'inspect', repo: 'one', paths: ['src'], budget: { maxToolCalls: 3 } },
      extra,
    );
    expect(mocks.tools).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'one', paths: ['src'] }),
    );
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: extra.signal,
        scope: { repo: 'one', paths: ['src'], note_paths: undefined },
        budget: { maxToolCalls: 3 },
      }),
      expect.objectContaining({
        limits: expect.objectContaining({ maxToolCalls: 12, timeoutMs: 90000 }),
      }),
    );
    expect(mocks.provider).toHaveBeenCalledWith({
      endpoint: 'http://localhost:9999/v1/chat/completions',
      model: 'small',
      apiKey: 'secret',
    });
  });
  it('exposes failed results as MCP errors but partial results as inspectable outputs', async () => {
    mocks.run.mockResolvedValue({ status: 'failed', usage: { toolCalls: 0, durationMs: 1 } });
    expect((await handler({ task: 'inspect', repo: 'one' }, extra)).isError).toBe(true);
    mocks.run.mockResolvedValue({ status: 'partial', usage: { toolCalls: 1, durationMs: 1 } });
    expect((await handler({ task: 'inspect', repo: 'one' }, extra)).isError).toBe(false);
  });
});
