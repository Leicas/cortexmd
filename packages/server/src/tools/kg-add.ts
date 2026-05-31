import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { kgAddTriple } from '../lib/knowledge-graph.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';

export function register(server: McpServer): void {
  server.tool(
    "kg_add",
    `Add a triple (subject → predicate → object) to the temporal knowledge graph.

Creates a directed relationship between two entities. Entities are auto-created if they don't exist yet. Each triple is uniquely identified by the combination of subject + predicate + object. If the same triple already exists, its validity window and confidence are updated instead of creating a duplicate. Use validFrom to record when the relationship became true (defaults to today). Use confidence (0–1) to express certainty.`,
    {
      subject: z.string().describe("The source entity (e.g. 'Alice', 'Project Alpha')"),
      predicate: z.string().describe("The relationship type (e.g. 'works_on', 'reports_to', 'lives_in')"),
      object: z.string().describe("The target entity (e.g. 'Engineering', 'Bob', 'Paris')"),
      validFrom: z.string().optional().describe("ISO date when the relationship started (defaults to today)"),
      confidence: z.number().min(0).max(1).optional().describe("Confidence score 0–1 (default 1.0)"),
      source: z.string().optional().describe("Provenance — where this fact came from (e.g. note path, conversation)"),
    },
    wrapToolHandler("kg_add", async (params) => {
      const subject = params.subject as string;
      const predicate = params.predicate as string;
      const object = params.object as string;

      const result = kgAddTriple(subject, predicate, object, {
        validFrom: params.validFrom as string | undefined,
        confidence: params.confidence as number | undefined,
        source: params.source as string | undefined,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              created: result.created,
              subject,
              predicate,
              object,
            }),
          },
        ],
      };
    })
  );
}
