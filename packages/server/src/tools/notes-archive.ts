import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';
import { archiveNoteInPlace } from '../lib/note-actions.js';

export function register(server: McpServer): void {
  server.tool(
    "notes_archive",
    "Archive a note by updating its frontmatter and optionally copying to an Archive folder",
    {
      path: z.string().describe("Vault-relative path to the note"),
      reason: z.string().optional().describe("Reason for archiving"),
      moveToArchive: z.boolean().optional().default(false).describe("Whether to also write a copy to Archive/"),
    },
    wrapToolHandler("notes_archive", async (params) => {
      const notePath = sanitizePath(params.path as string);
      const reason = params.reason as string | undefined;
      const moveToArchive = params.moveToArchive as boolean ?? false;

      const { archiveCopyPath } = await archiveNoteInPlace(notePath, reason, moveToArchive);

      const result: Record<string, unknown> = {
        path: notePath,
        archived: true,
      };
      if (archiveCopyPath) {
        result.archiveCopyPath = archiveCopyPath;
      }

      const summary = `Archived "${notePath}"` +
        (reason ? ` (reason: ${reason})` : '') +
        (archiveCopyPath ? `\nCopy written to ${archiveCopyPath}` : '');

      return {
        content: [{
          type: "text",
          text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
        }],
      };
    })
  );
}
