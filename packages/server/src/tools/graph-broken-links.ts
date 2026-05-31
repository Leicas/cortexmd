import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { findBrokenLinks } from '../lib/graph.js';

export function register(server: McpServer): void {
  server.tool(
    'graph_broken_links',
    `Scan the vault for wiki-links whose targets do not resolve to any known file. Returns a list of broken-link occurrences with source path, the broken target string, and (best-effort) line number.

Useful for: vault hygiene, catching typos in link targets, finding notes referenced but never created, diagnosing link-graph holes. The default link-resolution is lenient (basename match) — anything this tool surfaces is genuinely unresolved.`,
    {
      scopePaths: z
        .array(z.string())
        .optional()
        .describe('Only include broken links whose source path starts with one of these prefixes'),
      limit: z
        .number()
        .optional()
        .default(200)
        .describe('Maximum number of broken-link entries to return (default: 200)'),
    },
    wrapToolHandler('graph_broken_links', async (params) => {
      const scopePaths = params.scopePaths as string[] | undefined;
      const limit = (params.limit as number | undefined) ?? 200;

      let broken = await findBrokenLinks();

      if (scopePaths && scopePaths.length > 0) {
        broken = broken.filter((b) => scopePaths.some((p) => b.sourcePath.startsWith(p)));
      }

      const total = broken.length;
      const sliced = broken.slice(0, limit);

      // Aggregate counts by source path for a quick human-readable summary
      const bySource = new Map<string, number>();
      for (const b of broken) {
        bySource.set(b.sourcePath, (bySource.get(b.sourcePath) ?? 0) + 1);
      }
      const topSources = [...bySource.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      const summary =
        `Found ${total} broken wiki-link${total === 1 ? '' : 's'}` +
        (total > sliced.length ? ` — showing first ${sliced.length}` : '') +
        (topSources.length > 0
          ? `\nTop sources: ${topSources.map(([p, n]) => `${p} (${n})`).join(', ')}`
          : '');

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n${JSON.stringify(
              { total, broken: sliced },
              null,
              2,
            )}`,
          },
        ],
      };
    }),
  );
}
