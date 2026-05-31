import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getExtendedGraphStats } from '../lib/graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    'graph_stats',
    `Graph overview: total links, average links per note, orphan notes, most-linked notes, bridge count, connected components, largest component size, and sampled average path length. Use this for a quick health check of the vault's link structure or to understand connectivity before traversing.`,
    {},
    wrapToolHandler('graph_stats', async () => {
      const stats = await getExtendedGraphStats();
      if (!stats) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'Graph has not been built yet' }),
            },
          ],
        };
      }

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
