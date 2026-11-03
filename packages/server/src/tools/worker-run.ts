import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { createWorkerTools } from '../lib/worker-tools.js';
import { createCompatibleProvider, runWorker, WorkerSemaphore } from '../lib/worker/index.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

const budgetSchema = z
  .object({
    maxToolCalls: z.number().int().positive().optional(),
    maxRounds: z.number().int().positive().optional(),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    maxToolResultBytes: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export const workerRunSchema = z
  .object({
    task: z.string().min(1).max(16000),
    mode: z.enum(['code-investigator', 'knowledge-investigator']).default('code-investigator'),
    repo: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]*$/i)
      .optional(),
    paths: z.array(z.string().min(1).max(1024)).min(1).max(20).optional(),
    note_paths: z.array(z.string().min(1).max(1024)).min(1).max(20).optional(),
    budget: budgetSchema.optional(),
  })
  .strict();

let semaphore: WorkerSemaphore | undefined;

export function register(server: McpServer): void {
  server.tool(
    'worker_run',
    'Run an explicitly configured smaller model with bounded, read-only CortexMD tools. Requires WORKER_ENABLED and a configured provider. Code mode requires repo; knowledge mode requires explicit note_paths. Returns evidence and partial coverage, never writes or indexes. Uses the same server access boundary as ordinary CortexMD tools; scope narrows this run, not a new per-user ACL. Source data is sent to the administrator-configured model provider.',
    workerRunSchema.shape,
    async (args, extra) =>
      wrapToolHandler('worker_run', async () => {
        if (!config.workerEnabled)
          throw new Error(
            'Worker execution is disabled; set WORKER_ENABLED=true and configure a provider',
          );
        if (
          config.workerProvider !== 'openai-compatible' ||
          !config.workerEndpoint ||
          !config.workerModel
        )
          throw new Error('Worker provider, endpoint, and model must be explicitly configured');
        const parsed = workerRunSchema.parse(args);
        if (parsed.mode === 'code-investigator' && (parsed.note_paths || !parsed.repo))
          throw new Error('Code mode requires repo and does not accept note_paths');
        if (
          parsed.mode === 'knowledge-investigator' &&
          (parsed.repo || parsed.paths || !parsed.note_paths)
        )
          throw new Error('Knowledge mode requires note_paths and does not accept repo or paths');
        semaphore ??= new WorkerSemaphore(config.workerMaxConcurrency);
        const provider = createCompatibleProvider({
          endpoint: config.workerEndpoint,
          model: config.workerModel,
          apiKey: config.workerApiKey || undefined,
        });
        const tools = createWorkerTools(parsed);
        const result = await runWorker(
          {
            task: parsed.task,
            mode: parsed.mode,
            scope: { repo: parsed.repo, paths: parsed.paths, note_paths: parsed.note_paths },
            budget: parsed.budget,
            signal: extra.signal,
          },
          {
            provider,
            ...tools,
            semaphore,
            limits: {
              maxToolCalls: config.workerMaxToolCalls,
              maxRounds: config.workerMaxRounds,
              maxInputTokens: config.workerMaxInputTokens,
              maxOutputTokens: config.workerMaxOutputTokens,
              maxToolResultBytes: config.workerMaxToolResultBytes,
              timeoutMs: config.workerTimeoutMs,
            },
          },
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: result.status === 'failed',
          _detail: `${parsed.mode}: ${result.status}, ${result.usage.toolCalls} calls, ${result.usage.durationMs}ms`,
        };
      })(args, extra),
  );
}
