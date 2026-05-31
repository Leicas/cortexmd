import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { appendToContent } from '../lib/markdown.js';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath, sanitizeContent } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    "tasks_resolve",
    "Mark a task as done with a resolution note and supporting evidence",
    {
      taskRef: z.string().describe("Vault-relative path to the task note"),
      resolutionNote: z.string().describe("Summary of how the task was resolved"),
      evidence: z.array(z.string()).describe("List of evidence items or links supporting the resolution"),
    },
    wrapToolHandler("tasks_resolve", async (params) => {
      const taskRef = sanitizePath(params.taskRef as string);
      const resolutionNote = sanitizeContent(params.resolutionNote as string);
      const evidence = (params.evidence as string[]).map((e) => sanitizeContent(e, 1000));

      const { content, etag } = await readNote(taskRef);
      const { data, body } = parseFrontmatter(content);

      // Update frontmatter
      data.status = 'done';
      data.resolved_at = new Date().toISOString().slice(0, 10);
      data.last_updated = new Date().toISOString().slice(0, 10);

      // Build resolution section
      const evidenceLines = evidence.map((e) => `- ${e}`).join('\n');
      const resolutionSection = [
        '',
        '## Resolution',
        '',
        resolutionNote,
        '',
        '### Evidence',
        '',
        evidenceLines,
        '',
      ].join('\n');

      const updatedBody = appendToContent(body, resolutionSection);
      const finalContent = stringifyFrontmatter(data, updatedBody);

      await writeNote(taskRef, finalContent, etag);
      await appendJournalEntry(`Resolved task: [[${taskRef}]]`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ updated: true }),
        }],
      };
    })
  );
}
