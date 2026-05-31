import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { kgStats, isKgInitialized } from '../lib/knowledge-graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'kg_stats',
    `Knowledge graph overview: total entities, triples (active vs expired), top entities by connection count, and top predicates. Use this for a quick health check of the knowledge graph or to understand what it contains before querying.`,
    {},
    wrapToolHandler('kg_stats', async () => {
      if (!isKgInitialized()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'Knowledge graph is not initialized' }),
            },
          ],
        };
      }

      const stats = kgStats();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(stats),
          },
        ],
      };
    }),
  );
}
