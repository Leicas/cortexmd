import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { kgQueryEntity } from '../lib/knowledge-graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    "kg_query",
    `Query the temporal knowledge graph for all relationships involving an entity.

Returns the entity record and all triples where the entity appears as subject (outgoing), object (incoming), or both. Use the asOf parameter to see the state of relationships at a specific point in time — only triples valid at that date are returned. Without asOf, the full history (including expired triples) is returned.`,
    {
      entity: z.string().describe("Entity name to query (e.g. 'Alice', 'Project Alpha')"),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional().describe("Filter by relationship direction (default: both)"),
      asOf: z.string().optional().describe("ISO date to query point-in-time state — only triples valid at this date are returned"),
    },
    wrapToolHandler("kg_query", async (params) => {
      const entity = params.entity as string;
      const direction = (params.direction as 'outgoing' | 'incoming' | 'both' | undefined) ?? 'both';
      const asOf = params.asOf as string | undefined;

      const result = kgQueryEntity(entity, direction, asOf);

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
