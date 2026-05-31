import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runQualityBenchmark } from '../lib/benchmark.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { acquireOperation, releaseOperation } from '../lib/operation-mutex.js';

export function register(server: McpServer): void {
  server.tool(
    'benchmark_run',
    `Run a retrieval quality benchmark against the search index using a JSONL dataset. Each line in the dataset is {"query": "...", "expected_paths": ["..."], "category?": "..."}. Computes Recall@5, Recall@10, NDCG@5, NDCG@10, zero-recall rate, and latency metrics. Results are broken down by category if provided. Use this to measure and track search quality over time.`,
    {
      dataset: z
        .string()
        .optional()
        .describe(
          'Path to JSONL benchmark dataset (default: benchmarks/internal.jsonl)',
        ),
      limit: z
        .number()
        .optional()
        .describe('Maximum number of queries to run from the dataset'),
    },
    wrapToolHandler('benchmark_run', async (params) => {
      const datasetRaw = (params.dataset as string | undefined) ?? 'benchmarks/internal.jsonl';

      // Reject absolute paths and traversal to prevent arbitrary file reads
      if (path.isAbsolute(datasetRaw) || datasetRaw.includes('..')) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Dataset path must be relative and cannot contain ".."' }) }],
          _detail: 'invalid_path',
        };
      }
      const datasetPath = path.resolve(process.cwd(), datasetRaw);

      if (!existsSync(datasetPath)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Dataset file not found: ${datasetPath}`,
                hint: 'Create a JSONL file with lines like: {"query": "search term", "expected_paths": ["path/to/note.md"], "category": "optional"}',
              }),
            },
          ],
          isError: true,
        };
      }

      if (!acquireOperation('benchmark')) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'A benchmark is already running', operation: 'benchmark' }) }],
          isError: true,
        };
      }

      try {
        const maxQueries = params.limit as number | undefined;
        const result = await runQualityBenchmark(datasetPath, maxQueries);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
          _detail: `queries=${result.totalQueries} recall@10=${result.recallAt10} ndcg@10=${result.ndcgAt10}`,
        };
      } finally {
        releaseOperation('benchmark');
      }
    }),
  );
}
