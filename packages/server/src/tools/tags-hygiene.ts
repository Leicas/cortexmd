import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { getDocMeta, indexNote } from '../lib/search.js';
import { readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { appendJournalEntry } from '../lib/journal.js';

interface SingletonEntry {
  tag: string;
  count: number;
  paths: string[];
}

/**
 * Normalize a tag value for comparison (strip leading #, lowercase, trim).
 */
function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, '').trim().toLowerCase();
}

export function register(server: McpServer): void {
  // ── tags_singletons ────────────────────────────────────────────────────
  server.tool(
    'tags_singletons',
    `List tags that are used only once (or below a configurable threshold) across the vault.

Singletons are high-signal hygiene candidates: they either represent typos of an existing tag, or concepts that didn't catch on and should be merged into a broader tag. Returns each rare tag with its occurrence count and the notes that use it, so the caller can decide whether to merge (via tags_merge), delete, or keep.`,
    {
      minCount: z
        .number()
        .optional()
        .default(1)
        .describe('Maximum occurrence count to qualify as a "singleton" (default: 1 — tags used exactly once)'),
      limit: z
        .number()
        .optional()
        .default(200)
        .describe('Maximum number of tag entries to return'),
    },
    wrapToolHandler('tags_singletons', async (params) => {
      const threshold = (params.minCount as number | undefined) ?? 1;
      const limit = (params.limit as number | undefined) ?? 200;

      const docMeta = getDocMeta();
      const tagPaths = new Map<string, string[]>();

      for (const [path, meta] of docMeta) {
        for (const rawTag of meta.tags) {
          const tag = normalizeTag(rawTag);
          if (!tag) continue;
          const existing = tagPaths.get(tag);
          if (existing) existing.push(path);
          else tagPaths.set(tag, [path]);
        }
      }

      const entries: SingletonEntry[] = [];
      for (const [tag, paths] of tagPaths) {
        if (paths.length <= threshold) {
          entries.push({ tag, count: paths.length, paths });
        }
      }

      // Sort by count asc, then tag alpha
      entries.sort((a, b) => {
        if (a.count !== b.count) return a.count - b.count;
        return a.tag.localeCompare(b.tag);
      });

      const total = entries.length;
      const sliced = entries.slice(0, limit);

      const summary =
        `Found ${total} singleton tag${total === 1 ? '' : 's'} (count <= ${threshold})` +
        (total > sliced.length ? ` — showing first ${sliced.length}` : '');

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n${JSON.stringify(
              { total, threshold, singletons: sliced },
              null,
              2,
            )}`,
          },
        ],
      };
    }),
  );

  // ── tags_merge ─────────────────────────────────────────────────────────
  server.tool(
    'tags_merge',
    `Merge one or more source tags into a single target tag across all affected notes. Rewrites the frontmatter tags array — case-insensitive match, preserves other tags, deduplicates.

DRY-RUN BY DEFAULT. Set dryRun=false to actually write changes. Returns the list of notes that would be (or were) modified.`,
    {
      from: z
        .array(z.string())
        .min(1)
        .describe('Source tags to merge (e.g. ["projectA", "project-a"])'),
      to: z.string().describe('Target tag to merge into (e.g. "project-alpha")'),
      dryRun: z
        .boolean()
        .optional()
        .default(true)
        .describe('If true (default), report what would change without writing. Set false to apply.'),
    },
    wrapToolHandler('tags_merge', async (params) => {
      const fromRaw = params.from as string[];
      const toRaw = params.to as string;
      const dryRun = (params.dryRun as boolean | undefined) !== false; // default true

      const fromSet = new Set(fromRaw.map(normalizeTag).filter(Boolean));
      const target = normalizeTag(toRaw);
      if (!target) {
        throw new Error('`to` tag is empty after normalization');
      }
      if (fromSet.size === 0) {
        throw new Error('`from` must contain at least one non-empty tag');
      }
      // Don't rewrite a tag to itself
      fromSet.delete(target);
      if (fromSet.size === 0) {
        throw new Error('`from` contained only the target tag — nothing to merge');
      }

      const docMeta = getDocMeta();
      const candidates: string[] = [];
      for (const [path, meta] of docMeta) {
        for (const rawTag of meta.tags) {
          if (fromSet.has(normalizeTag(rawTag))) {
            candidates.push(path);
            break;
          }
        }
      }

      const changes: Array<{ path: string; before: string[]; after: string[] }> = [];
      const errors: Array<{ path: string; error: string }> = [];

      for (const filePath of candidates) {
        try {
          const { content } = await readNote(filePath);
          const { data, body } = parseFrontmatter(content);

          // Tags can live in `tags` as string[] or comma-separated string
          const rawTags = data.tags;
          let tagList: string[];
          let serializeAsString = false;
          if (Array.isArray(rawTags)) {
            tagList = rawTags.map((t) => String(t));
          } else if (typeof rawTags === 'string') {
            tagList = rawTags.split(/[,\s]+/).filter(Boolean);
            serializeAsString = true;
          } else {
            continue; // no tags field to rewrite
          }

          const before = [...tagList];
          const rewritten: string[] = [];
          const seen = new Set<string>();
          let touched = false;

          for (const t of tagList) {
            const norm = normalizeTag(t);
            if (!norm) continue;
            if (fromSet.has(norm)) {
              touched = true;
              if (!seen.has(target)) {
                rewritten.push(target);
                seen.add(target);
              }
            } else {
              if (!seen.has(norm)) {
                rewritten.push(t); // preserve original casing of non-merged tags
                seen.add(norm);
              }
            }
          }

          // Ensure target is present if anything was merged
          if (touched && !seen.has(target)) {
            rewritten.push(target);
            seen.add(target);
          }

          if (!touched) continue;

          changes.push({ path: filePath, before, after: rewritten });

          if (!dryRun) {
            if (serializeAsString) {
              data.tags = rewritten.join(', ');
            } else {
              data.tags = rewritten;
            }
            const updated = stringifyFrontmatter(data, body);
            await writeNote(filePath, updated);
            await indexNote(filePath);
          }
        } catch (err) {
          errors.push({
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!dryRun && changes.length > 0) {
        try {
          await appendJournalEntry(
            `Tag merge: [${[...fromSet].join(', ')}] -> ${target} across ${changes.length} note${changes.length === 1 ? '' : 's'}`,
          );
        } catch {
          // Journal errors shouldn't fail the merge
        }
      }

      const summary =
        `${dryRun ? 'DRY-RUN: would merge' : 'Merged'} [${[...fromSet].join(', ')}] -> ${target} on ` +
        `${changes.length} note${changes.length === 1 ? '' : 's'}` +
        (errors.length > 0 ? ` (${errors.length} error${errors.length === 1 ? '' : 's'})` : '');

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n${JSON.stringify(
              {
                dryRun,
                from: [...fromSet],
                to: target,
                modified: changes.length,
                changes,
                errors,
              },
              null,
              2,
            )}`,
          },
        ],
      };
    }),
  );
}
