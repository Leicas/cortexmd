import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bfsTraverse, findBridgeNodes } from '../lib/graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    'graph_traverse',
    `BFS traversal of the knowledge graph starting from a given note. Returns discovered nodes with their hop distance and all edges traversed. Use this to: map the neighborhood of a topic beyond direct neighbors, find how two notes might be connected through intermediate links, discover clusters of related content, and visualize local graph structure. Traversal follows both outgoing [[wiki-links]] and backlinks bidirectionally.`,
    {
      startPath: z
        .string()
        .describe(
          'Vault-relative path of the starting note (e.g. Projects/Acme.md)',
        ),
      maxHops: z
        .number()
        .min(1)
        .max(5)
        .optional()
        .describe('Maximum traversal depth (1-5, default 2)'),
      limit: z
        .number()
        .min(1)
        .optional()
        .describe(
          'Maximum number of nodes to return (default 50, prevents blowup on dense graphs)',
        ),
    },
    wrapToolHandler('graph_traverse', async (params) => {
      const startPath = sanitizePath(params.startPath as string);
      const maxHops = (params.maxHops as number | undefined) ?? 2;
      const limit = (params.limit as number | undefined) ?? 50;

      const result = await bfsTraverse(startPath, maxHops, limit);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    }),
  );

  server.tool(
    'graph_bridges',
    `Find bridge nodes in the knowledge graph — notes whose links span multiple collections (Memories, CRM, Projects, etc.). Bridge nodes are important connectors that tie different areas of the vault together. Use this to: identify key linking notes between domains, find cross-cutting concerns, discover notes that could benefit from splitting or better organization. Optionally filter to bridges connecting two specific collections.`,
    {
      collectionA: z
        .string()
        .optional()
        .describe(
          'First collection name to filter bridges (e.g. "memories", "projects")',
        ),
      collectionB: z
        .string()
        .optional()
        .describe('Second collection name to filter bridges'),
    },
    wrapToolHandler('graph_bridges', async (params) => {
      const collectionA = params.collectionA as string | undefined;
      const collectionB = params.collectionB as string | undefined;

      const bridges = await findBridgeNodes(collectionA, collectionB);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              count: bridges.length,
              bridges: bridges.slice(0, 50),
            }),
          },
        ],
      };
    }),
  );
}
