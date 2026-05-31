import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { kgTimeline } from '../lib/knowledge-graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    "kg_timeline",
    `Retrieve a chronological timeline of knowledge graph triples.

Returns triples sorted by their valid_from date (or creation date if valid_from is null). Optionally filter to a single entity to see how its relationships evolved over time. Without a filter, returns the full timeline across all entities.`,
    {
      entity: z.string().optional().describe("Optional entity name to filter the timeline to"),
    },
    wrapToolHandler("kg_timeline", async (params) => {
      const entity = params.entity as string | undefined;

      const triples = kgTimeline(entity);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: triples.length, triples }),
          },
        ],
      };
    })
  );
}
