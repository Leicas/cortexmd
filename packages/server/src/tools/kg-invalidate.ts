import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { kgInvalidateTriple } from '../lib/knowledge-graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    "kg_invalidate",
    `Mark a knowledge graph triple as no longer valid (set its end date).

This does not delete the triple — it records when the relationship ended, preserving full temporal history. For example, if Alice no longer works on Project Alpha, invalidating that triple sets valid_to to the given date while keeping the historical record that she once did. Only affects triples that are currently active (valid_to IS NULL).`,
    {
      subject: z.string().describe("The source entity of the triple to invalidate"),
      predicate: z.string().describe("The relationship type of the triple to invalidate"),
      object: z.string().describe("The target entity of the triple to invalidate"),
      ended: z.string().optional().describe("ISO date when the relationship ended (defaults to today)"),
    },
    wrapToolHandler("kg_invalidate", async (params) => {
      const subject = params.subject as string;
      const predicate = params.predicate as string;
      const object = params.object as string;
      const ended = params.ended as string | undefined;

      const updated = kgInvalidateTriple(subject, predicate, object, ended);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              invalidated: updated,
              subject,
              predicate,
              object,
              ended: ended ?? new Date().toISOString().slice(0, 10),
            }),
          },
        ],
      };
    })
  );
}
