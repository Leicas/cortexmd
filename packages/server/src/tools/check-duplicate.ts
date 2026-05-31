import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkSemanticDuplicate } from '../lib/embeddings.js';
import type { DuplicateCheckMode } from '../lib/embeddings.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    "check_duplicate",
    "Check if content is similar to an existing note in the vault. Two modes: 'semantic' (cosine similarity on sentence embeddings; default threshold 0.92) or 'structural' (dates/times/numbers/templated filler normalized then token-bigram Jaccard; default threshold 0.85). Use 'structural' for cron-log / auto-save style near-duplicates that semantic misses.",
    {
      content: z.string().describe("Content to check for duplicates"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Similarity threshold (0–1). Default 0.92 for semantic, 0.85 for structural"),
      mode: z
        .enum(['semantic', 'structural'])
        .optional()
        .describe("Duplicate detection mode. 'semantic' (default) uses embeddings; 'structural' normalizes dates/numbers/filler and catches templated near-duplicates."),
    },
    wrapToolHandler("check_duplicate", async (params) => {
      const content = params.content as string;
      const threshold = params.threshold as number | undefined;
      const mode = (params.mode as DuplicateCheckMode | undefined) ?? 'semantic';

      const result = await checkSemanticDuplicate(content, threshold, mode);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    })
  );
}
