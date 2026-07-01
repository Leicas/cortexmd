import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listFiles, readNote } from '../lib/vault.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';
import { getDocMeta } from '../lib/search.js';

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

/**
 * Bounded-concurrency map. Runs `worker` over `items` with at most `limit`
 * in flight at once. Preserves input order in the result.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners: Promise<void>[] = [];
  const size = Math.min(limit, items.length);
  for (let w = 0; w < size; w++) {
    runners.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= items.length) break;
          results[i] = await worker(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

function coerceDate(raw: unknown): string | undefined {
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'string') return raw;
  return undefined;
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

      // Cap how many files we consider
      const cap = Math.min(files.length, 500);
      const docMeta = getDocMeta();

      // Phase 1: serve title/type/temperature/heat_score/tags from the
      // in-memory docMeta index and apply filters there — no disk I/O. Files
      // missing from the index fall back to a disk read (rare: unindexed).
      interface Candidate {
        path: string;
        title: string;
        type?: string;
        temperature?: string;
        heat_score?: number;
        tags: string[];
        // created is available from meta.date; updated is not carried in meta,
        // so it is resolved from disk in phase 2 only for surviving candidates.
        created?: string;
      }

      const candidates: Candidate[] = [];
      const diskFallbackPaths: string[] = [];

      for (let i = 0; i < cap; i++) {
        const filePath = files[i];
        const meta = docMeta.get(filePath);
        if (!meta) {
          // Not indexed — defer to a full disk read below.
          diskFallbackPaths.push(filePath);
          continue;
        }

        const tags = meta.tags ?? [];
        const noteType = meta.type;
        const noteTemperature = meta.temperature;

        // Apply filters using the cached fields.
        if (filterType && noteType !== filterType) continue;
        if (filterTemperature && noteTemperature !== filterTemperature) continue;
        if (filterTags && filterTags.length > 0) {
          if (!filterTags.some((t) => tags.includes(t))) continue;
        }

        candidates.push({
          path: filePath,
          title: meta.title,
          type: noteType,
          temperature: noteTemperature,
          heat_score: meta.heat_score,
          tags,
          // meta.date === frontmatter date ?? created
          created: coerceDate(meta.date),
        });
      }

      const entries: NoteEntry[] = [];

      // Phase 1b: files absent from the index — full disk read (parse
      // frontmatter for every field), applying the same filters.
      if (diskFallbackPaths.length > 0) {
        await mapWithConcurrency(diskFallbackPaths, 16, async (filePath) => {
          try {
            const { content } = await readNote(filePath);
            const { data } = parseFrontmatter(content);

            const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
            const noteType = data.type as string | undefined;
            const noteTemperature = data.temperature as string | undefined;
            const heatScore = typeof data.heat_score === 'number' ? data.heat_score : undefined;

            if (filterType && noteType !== filterType) return;
            if (filterTemperature && noteTemperature !== filterTemperature) return;
            if (filterTags && filterTags.length > 0) {
              if (!filterTags.some((t) => tags.includes(t))) return;
            }

            const title =
              (data.title as string) ??
              filePath.replace(/\.md$/, '').split('/').pop() ??
              filePath;

            const created = coerceDate(data.created);
            const updated = coerceDate(data.last_updated ?? data.updated);

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
        });
      }

      // Phase 2: resolve the `updated` timestamp (not carried in docMeta) for
      // surviving candidates only, in parallel with bounded concurrency. This
      // reads far fewer files than the old per-file serial loop, since filters
      // have already pruned the set.
      const resolved = await mapWithConcurrency(candidates, 16, async (c) => {
        let created = c.created;
        let updated: string | undefined;
        try {
          const { content } = await readNote(c.path);
          const { data } = parseFrontmatter(content);
          updated = coerceDate(data.last_updated ?? data.updated);
          // Prefer frontmatter created if meta.date was empty.
          if (created === undefined) created = coerceDate(data.created);
        } catch {
          // meta-only values stand if the file is unreadable
        }
        const entry: NoteEntry = {
          path: c.path,
          title: c.title,
          type: c.type,
          temperature: c.temperature,
          heat_score: c.heat_score,
          tags: c.tags,
          created,
          updated,
        };
        return entry;
      });
      entries.push(...resolved);

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
