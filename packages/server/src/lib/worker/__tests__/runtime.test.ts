import { describe, expect, it, vi } from 'vitest';
import { runWorker, WorkerSemaphore } from '../runtime.js';
import type { WorkerCompletion, WorkerDependencies } from '../index.js';

const call = (name = 'code_symbol_search', id = 'c1', args = '{}'): WorkerCompletion => ({
  content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: args } }],
  usage: { inputTokens: 100, outputTokens: 20 },
});
const final = (id = 'e1'): WorkerCompletion => ({
  content: JSON.stringify({
    answer: 'Found handler',
    findings: [{ claim: 'Handler exists', evidence_ids: [id] }],
    limitations: [],
  }),
  usage: { inputTokens: 100, outputTokens: 30 },
});
function dependencies(sequence: WorkerCompletion[]): WorkerDependencies {
  return {
    provider: { model: 'test-small', complete: vi.fn(async () => sequence.shift()!) },
    tools: [
      {
        name: 'code_symbol_search',
        description: 'Search indexed symbols',
        parameters: { type: 'object' },
      },
    ],
    executeTool: vi.fn(async () => ({
      content: { symbol: 'handler' },
      sources: [{ path: 'src/auth.ts', hash: 'abc' }],
      coverage: ['src/auth.ts'],
    })),
    semaphore: new WorkerSemaphore(1),
  };
}
const request = { task: 'Find handler', mode: 'code-investigator', scope: { repo: 'test' } };

describe('bounded worker runtime', () => {
  it('executes an iterative investigation and assigns source evidence itself', async () => {
    const deps = dependencies([call(), final()]);
    const result = await runWorker(request, deps);
    expect(result.status).toBe('complete');
    expect(result.evidence[0]).toMatchObject({
      id: 'e1',
      sources: [{ path: 'src/auth.ts', hash: 'abc' }],
    });
    expect(result.usage).toMatchObject({
      toolCalls: 1,
      rounds: 2,
      inputTokens: 200,
      outputTokens: 50,
    });
    expect(result.coverage.inspected).toEqual(['src/auth.ts']);
    expect(result.evidence[0]).not.toHaveProperty('content');
  });
  it('refuses invented citations', async () => {
    const result = await runWorker(request, dependencies([call(), final('e999')]));
    expect(result.status).toBe('failed');
    expect(result.findings).toEqual([]);
  });
  it('does not report an uncited answer as complete after retrieving evidence', async () => {
    const deps = dependencies([
      call(),
      {
        content: JSON.stringify({ answer: 'Everything is secure', findings: [], limitations: [] }),
      },
    ]);
    const result = await runWorker(request, deps);
    expect(result.status).toBe('partial');
    expect(result.evidence).toHaveLength(1);
    expect(result.coverage.limitations.join(' ')).toContain('No evidence-backed findings');
  });
  it.each(['notes_upsert', 'worker_run', 'shell'])(
    'does not execute an unadvertised %s tool',
    async (name) => {
      const deps = dependencies([call(name)]);
      expect((await runWorker(request, deps)).status).toBe('failed');
      expect(deps.executeTool).not.toHaveBeenCalled();
    },
  );
  it('rejects accidentally advertised mutation tools', async () => {
    const deps = dependencies([]);
    deps.tools.push({ name: 'memory_store', description: '', parameters: {} });
    expect((await runWorker(request, deps)).status).toBe('failed');
    expect(deps.provider.complete).not.toHaveBeenCalled();
  });
  it('stops repeated calls at server limits even if caller requests more', async () => {
    const deps = dependencies([call(), call('code_symbol_search', 'c2')]);
    deps.limits = { maxToolCalls: 1 };
    const result = await runWorker({ ...request, budget: { maxToolCalls: 100 } }, deps);
    expect(result.status).toBe('partial');
    expect(result.usage.toolCalls).toBe(1);
  });
  it('counts cumulative history and schemas against input budget before sending', async () => {
    const deps = dependencies([call(), final()]);
    const first = await runWorker(request, deps);
    const singleRound = (deps.provider.complete as any).mock.calls[0][0];
    // With a tiny input budget no provider request is made, including expensive tool schemas.
    const blocked = dependencies([]);
    blocked.tools[0].description = 'x'.repeat(4000);
    const result = await runWorker({ ...request, budget: { maxInputTokens: 3000 } }, blocked);
    expect(result.status).toBe('partial');
    expect(blocked.provider.complete).not.toHaveBeenCalled();
    expect(first.usage.estimatedInputTokens).toBeGreaterThan(2000);
    expect(singleRound).toBeDefined();
  });
  it('does not feed oversized tool results to the model or cite them', async () => {
    const deps = dependencies([
      call(),
      { content: JSON.stringify({ answer: '', findings: [], limitations: ['Missing source'] }) },
    ]);
    deps.limits = { maxToolResultBytes: 10 };
    const result = await runWorker(request, deps);
    expect(result.status).toBe('partial');
    expect(result.evidence).toEqual([]);
    expect(JSON.stringify((deps.provider.complete as any).mock.calls[1][0].messages)).not.toContain(
      'src/auth.ts',
    );
  });
  it('counts tool errors without converting them into evidence', async () => {
    const deps = dependencies([call(), final()]);
    deps.executeTool = vi.fn(async () => ({ content: 'denied', isError: true }));
    const result = await runWorker(request, deps);
    expect(result.usage.toolCalls).toBe(1);
    expect(result.evidence).toEqual([]);
    expect(result.status).toBe('failed');
  });
  it('preserves dispatcher freshness limitations even when model claims completion', async () => {
    const deps = dependencies([call(), final()]);
    deps.executeTool = async () => ({
      content: 'indexed content',
      sources: [{ path: 'src/auth.ts' }],
      limitations: ['Source snapshot may be stale'],
    });
    const result = await runWorker(request, deps);
    expect(result.status).toBe('partial');
    expect(result.coverage.inspected).toEqual(['src/auth.ts']);
    expect(result.coverage.limitations).toContain('Source snapshot may be stale');
  });
  it('rejects malformed arguments before dispatch', async () => {
    const deps = dependencies([call('code_symbol_search', 'c1', '[]')]);
    expect((await runWorker(request, deps)).status).toBe('failed');
    expect(deps.executeTool).not.toHaveBeenCalled();
  });
  it('rejects repeated call IDs', async () => {
    const deps = dependencies([call(), call()]);
    const result = await runWorker(request, deps);
    expect(result.status).toBe('failed');
    expect(result.usage.toolCalls).toBe(1);
  });
  it('returns partial on output truncation and preserves retrieved evidence', async () => {
    const result = await runWorker(
      request,
      dependencies([call(), { ...final(), truncated: true }]),
    );
    expect(result.status).toBe('partial');
    expect(result.evidence).toHaveLength(1);
    expect(result.findings).toEqual([]);
  });
  it('cancels an uncooperative provider and releases admission capacity', async () => {
    const deps = dependencies([]);
    deps.provider.complete = () => new Promise(() => {});
    const controller = new AbortController();
    const pending = runWorker({ ...request, signal: controller.signal }, deps);
    controller.abort();
    expect((await pending).status).toBe('cancelled');
    const release = deps.semaphore!.acquire();
    expect(release).toBeTypeOf('function');
    release!();
  });
  it('times out a tool that ignores cancellation', async () => {
    const deps = dependencies([call()]);
    deps.executeTool = () => new Promise(() => {});
    const result = await runWorker({ ...request, budget: { timeoutMs: 10 } }, deps);
    expect(result.status).toBe('partial');
    expect(result.coverage.limitations).toContain('Worker time budget exhausted');
  });
  it('refuses concurrency overflow without invoking provider', async () => {
    const deps = dependencies([]);
    const release = deps.semaphore!.acquire()!;
    const result = await runWorker(request, deps);
    expect(result.status).toBe('failed');
    expect(deps.provider.complete).not.toHaveBeenCalled();
    release();
  });
  it('does not leak provider or dispatcher exception text', async () => {
    const deps = dependencies([]);
    deps.provider.complete = async () => {
      throw new Error('Bearer SECRET private.example');
    };
    expect(JSON.stringify(await runWorker(request, deps))).not.toContain('SECRET');
  });
  it('reports unavailable provider usage honestly', async () => {
    const deps = dependencies([
      { ...call(), usage: undefined },
      { ...final(), usage: undefined },
    ]);
    const result = await runWorker(request, deps);
    expect(result.status).toBe('complete');
    expect(result.usage.providerUsageComplete).toBe(false);
    expect(result.usage.estimatedOutputTokens).toBeGreaterThan(0);
  });
});
