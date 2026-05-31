import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDocMeta } from '../lib/search.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    "tags_list",
    "List all tags used across indexed notes with occurrence counts, optionally filtered by prefix",
    {
      prefix: z.string().optional().describe("Filter tags starting with this prefix"),
      minCount: z
        .number()
        .optional()
        .default(1)
        .describe("Minimum occurrence count to include a tag"),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Maximum number of tags to return"),
    },
    wrapToolHandler("tags_list", async (params) => {
      const prefix = params.prefix as string | undefined;
      const minCount = (params.minCount as number | undefined) ?? 1;
      const limit = (params.limit as number | undefined) ?? 100;

      const docMeta = getDocMeta();
      const tagCounts = new Map<string, number>();

      for (const [, meta] of docMeta) {
        for (const tag of meta.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }
      }

      // Filter and sort
      let entries = Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }));

      if (prefix) {
        entries = entries.filter((e) => e.tag.startsWith(prefix));
      }

      entries = entries.filter((e) => e.count >= minCount);
      entries.sort((a, b) => b.count - a.count);

      const total = entries.length;
      const tags = entries.slice(0, limit);

      const summary = `Found ${total} tags` +
        (prefix ? ` matching prefix "${prefix}"` : '') +
        (tags.length < total ? ` (showing top ${tags.length})` : '') +
        `:\n` +
        tags.map((t) => `  ${t.tag} (${t.count})`).join('\n');

      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n${JSON.stringify({ tags, total }, null, 2)}`,
          },
        ],
      };
    })
  );
}
