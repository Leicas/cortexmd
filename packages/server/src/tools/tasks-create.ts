import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter, ensureId } from '../lib/frontmatter.js';
import { searchNotes } from '../lib/search.js';
import { appendJournalEntry } from '../lib/journal.js';
import { computeEtag } from '../lib/hash.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizeQuery, sanitizeContent, sanitizePath } from '../lib/sanitize.js';

export function register(server: McpServer): void {
  server.tool(
    "tasks_create_or_update",
    "Create a new task or update an existing one, with optional deduplication against existing tasks",
    {
      title: z.string().describe("Title of the task"),
      description: z.string().describe("Description of the task"),
      owner: z.string().describe("Owner/assignee of the task"),
      projectPath: z.string().optional().describe("Vault-relative path to the related project note"),
      dedupe: z.boolean().optional().default(true).describe("Whether to check for duplicate tasks before creating"),
    },
    wrapToolHandler("tasks_create_or_update", async (params) => {
      const title = sanitizeQuery(params.title as string);
      const description = sanitizeContent(params.description as string);
      const owner = sanitizeContent(params.owner as string, 200);
      const projectPath = params.projectPath
        ? sanitizePath(params.projectPath as string)
        : undefined;
      const dedupe = params.dedupe as boolean | undefined;

      // Deduplication: search for existing tasks with similar title
      if (dedupe !== false) {
        try {
          const results = searchNotes(title, { limit: 10 });

          for (const result of results) {
            try {
              const { content } = await readNote(result.path);
              const { data } = parseFrontmatter(content);

              if (data.type !== 'task') continue;

              // Found a matching task
              const status = data.status?.toLowerCase();
              if (status === 'done' || status === 'canceled' || status === 'cancelled') {
                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      action: "skipped_duplicate",
                      match: result.path,
                    }),
                  }],
                };
              }

              // Open or in-progress task -- update it
              const { body } = parseFrontmatter(content);
              data.description = description;
              data.owner = owner;
              data.last_updated = new Date().toISOString().slice(0, 10);
              if (projectPath) {
                data.project = `[[${projectPath}]]`;
              }
              const updatedContent = stringifyFrontmatter(data, body);
              await writeNote(result.path, updatedContent);
              await appendJournalEntry(`Updated task: [[${result.path}]]`);

              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    action: "updated",
                    taskPath: result.path,
                    match: result.path,
                  }),
                }],
              };
            } catch {
              // Skip unreadable results
            }
          }
        } catch {
          // Search index may not be built yet; proceed to create
        }
      }

      // No match found -- create new task
      const sanitizedTitle = title.replace(/[\\/:*?"<>|]/g, '-');
      const taskPath = `Tasks/${sanitizedTitle}.md`;
      const now = new Date().toISOString().slice(0, 10);

      let frontmatter: Record<string, any> = {
        type: 'task',
        status: 'open',
        owner,
        created: now,
        last_updated: now,
      };
      frontmatter = ensureId(frontmatter);

      if (projectPath) {
        frontmatter.project = `[[${projectPath}]]`;
      }

      const body = `\n${description}\n`;
      const content = stringifyFrontmatter(frontmatter, body);
      await writeNote(taskPath, content);
      await appendJournalEntry(`Created task: [[${taskPath}]]`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: "created",
            taskPath,
          }),
        }],
      };
    })
  );
}
