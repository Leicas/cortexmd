import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getExtendedGraphStats, buildAndCacheGraph } from '../lib/graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { logger } from '../lib/logger.js';

// Single in-flight lazy build so concurrent graph_stats calls during startup
// share one walk instead of each rebuilding the whole link graph.
let lazyBuild: Promise<void> | null = null;

async function ensureGraphBuilt(): Promise<void> {
  if (!lazyBuild) {
    lazyBuild = buildAndCacheGraph()
      .catch((err) => {
        logger.warn('graph_stats: lazy graph build failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => { lazyBuild = null; });
  }
  return lazyBuild;
}

export function register(server: McpServer): void {
  server.tool(
    'graph_stats',
    `Graph overview: total links, average links per note, orphan notes, most-linked notes, bridge count, connected components, largest component size, and sampled average path length. Use this for a quick health check of the vault's link structure or to understand connectivity before traversing. Builds the link graph on first call if startup has not done so yet.`,
    {},
    wrapToolHandler('graph_stats', async () => {
      let stats = await getExtendedGraphStats();
      if (!stats) {
        // The startup build has not run (or was reset by a vault rebuild):
        // build lazily instead of telling the agent to come back later.
        await ensureGraphBuilt();
        stats = await getExtendedGraphStats();
      }
      if (!stats) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'Graph has not been built yet', hint: 'the vault is still indexing; retry in a minute' }),
            },
          ],
          isError: true,
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
