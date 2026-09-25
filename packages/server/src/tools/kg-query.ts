import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { kgQueryEntity, kgEvidence } from '../lib/knowledge-graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    "kg_query",
    `Query the temporal knowledge graph for all relationships involving an entity.

Returns the entity record and all triples with their supporting source evidence. Use asOf to see relationships valid at a specific date. Without asOf, full history is returned.`,
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
      const withEvidence = {
        ...result,
        triples: result.triples.map((triple) => ({ ...triple, evidence: kgEvidence(triple.id) })),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(withEvidence),
          },
        ],
      };
    })
  );
}
