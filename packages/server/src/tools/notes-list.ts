import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listFiles, readNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';

interface NoteEntry {
  path: string;
  title: string;
  type?: string;
  temperature?: string;
  heat_score?: number;
  tags: string[];
  created?: string;
  updated?: string;
}

export function register(server: McpServer): void {
  server.tool(
    "notes_list",
    "List notes in the vault with optional filtering by type, temperature, and tags, with sorting and pagination",
    {
      directory: z
        .string()
        .optional()
        .default('.')
        .describe("Vault-relative directory to list"),
      pattern: z
        .string()
        .optional()
        .default('**/*.md')
        .describe("Glob pattern for matching files"),
      filterType: z.string().optional().describe("Filter by frontmatter type field"),
      filterTemperature: z
        .enum(['hot', 'warm', 'cold'])
        .optional()
        .describe("Filter by temperature"),
      filterTags: z
        .array(z.string())
        .optional()
        .describe("Filter by tags (note must have at least one)"),
      sortBy: z
        .enum(['name', 'created', 'updated', 'heat_score'])
        .optional()
        .default('updated')
        .describe("Sort field"),
      offset: z
        .number()
        .optional()
        .default(0)
        .describe("Number of results to skip (for pagination)"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Maximum number of results"),
    },
    wrapToolHandler("notes_list", async (params) => {
      const directory = sanitizePath((params.directory as string | undefined) ?? '.');
      const pattern = (params.pattern as string | undefined) ?? '**/*.md';
      const filterType = params.filterType as string | undefined;
      const filterTemperature = params.filterTemperature as string | undefined;
      const filterTags = params.filterTags as string[] | undefined;
      const sortBy = (params.sortBy as string | undefined) ?? 'updated';
      const offset = (params.offset as number | undefined) ?? 0;
      const limit = (params.limit as number | undefined) ?? 50;

      const files = await listFiles(directory, pattern);

      // Cap how many files we read frontmatter for
      const cap = Math.min(files.length, 500);
      const entries: NoteEntry[] = [];

      for (let i = 0; i < cap; i++) {
        const filePath = files[i];
        try {
          const { content } = await readNote(filePath);
          const { data } = parseFrontmatter(content);

          const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
          const noteType = data.type as string | undefined;
          const noteTemperature = data.temperature as string | undefined;
          const heatScore = typeof data.heat_score === 'number' ? data.heat_score : undefined;

          // Apply filters
          if (filterType && noteType !== filterType) continue;
          if (filterTemperature && noteTemperature !== filterTemperature) continue;
          if (filterTags && filterTags.length > 0) {
            if (!filterTags.some((t) => tags.includes(t))) continue;
          }

          const title =
            (data.title as string) ??
            filePath.replace(/\.md$/, '').split('/').pop() ??
            filePath;

          // Coerce dates to strings — gray-matter may parse them as Date objects
          const rawCreated = data.created;
          const rawUpdated = data.last_updated ?? data.updated;
          const created = rawCreated instanceof Date ? rawCreated.toISOString() : typeof rawCreated === 'string' ? rawCreated : undefined;
          const updated = rawUpdated instanceof Date ? rawUpdated.toISOString() : typeof rawUpdated === 'string' ? rawUpdated : undefined;

          entries.push({
            path: filePath,
            title,
            type: noteType,
            temperature: noteTemperature,
            heat_score: heatScore,
            tags,
            created,
            updated,
          });
        } catch {
          // skip unreadable files
        }
      }

      // Sort
      entries.sort((a, b) => {
        switch (sortBy) {
          case 'name':
            return a.path.localeCompare(b.path);
          case 'created':
            return (b.created ?? '').localeCompare(a.created ?? '');
          case 'heat_score':
            return (b.heat_score ?? 0) - (a.heat_score ?? 0);
          case 'updated':
          default:
            return (b.updated ?? '').localeCompare(a.updated ?? '');
        }
      });

      const total = entries.length;
      const notes = entries.slice(offset, offset + limit);
      const hasMore = offset + limit < total;

      const summary = `Listed ${notes.length} of ${total} notes` +
        (offset > 0 ? ` (offset: ${offset})` : '') +
        (hasMore ? ` — more available` : '');

      return {
        content: [
          {
            type: "text",
            text: `${summary}\n\n${JSON.stringify({ notes, total, offset, limit, hasMore }, null, 2)}`,
          },
        ],
      };
    })
  );
}
