import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { detectEntities } from '../lib/entity-detector.js';
import { readNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath, sanitizeContent } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    "entity_detect",
    "Detect named entities (persons, projects, organizations) from content text or an existing note. Uses heuristic pattern matching with multiple signal requirement for high confidence. Returns detected entities with type, confidence score, and supporting signals.",
    {
      content: z.string().optional().describe("Text content to analyze for entities. Provide either content or path, not both"),
      path: z.string().optional().describe("Vault-relative path to a note to analyze. If provided, the note's body is read and analyzed"),
      minConfidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Minimum confidence threshold for returned entities (0–1). Default 0.6"),
    },
    wrapToolHandler("entity_detect", async (params) => {
      const rawContent = params.content as string | undefined;
      const rawPath = params.path as string | undefined;
      const minConfidence = (params.minConfidence as number | undefined) ?? 0.6;

      if (!rawContent && !rawPath) {
        throw new Error("Either 'content' or 'path' must be provided");
      }

      let textToAnalyze: string;
      let sourcePath: string | undefined;

      if (rawPath) {
        const notePath = sanitizePath(rawPath);
        sourcePath = notePath;
        const { content: noteContent } = await readNote(notePath);
        const { body } = parseFrontmatter(noteContent);
        textToAnalyze = body;
      } else {
        textToAnalyze = sanitizeContent(rawContent!);
      }

      const entities = detectEntities(textToAnalyze);

      // Filter by confidence threshold
      const filtered = entities.filter(e => e.confidence >= minConfidence);

      const responseData: Record<string, unknown> = {
        entities: filtered,
        totalDetected: entities.length,
        aboveThreshold: filtered.length,
        minConfidence,
      };

      if (sourcePath) {
        responseData.sourcePath = sourcePath;
      }

      const detailStr = `${filtered.length} entities detected` +
        (sourcePath ? ` from ${sourcePath}` : '') +
        (filtered.length > 0 ? ` (${filtered.map(e => e.name).join(', ')})` : '');

      return {
        _detail: detailStr,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(responseData, null, 2),
          },
        ],
      };
    })
  );
}
