import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import { listFiles, readNote, writeNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { sanitizePath } from '../lib/sanitize.js';
import { inferNoteCategory } from '../lib/categorize.js';
import { indexNote, getDocMeta } from '../lib/search.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

/**
 * Bounded-concurrency map. Runs `worker` over `items` with at most `limit`
 * in flight at once. Order of completion is not guaranteed.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const size = Math.min(limit, items.length);
  const runners: Promise<void>[] = [];
  for (let w = 0; w < size; w++) {
    runners.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= items.length) break;
          await worker(items[i]);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

interface PlanEntry {
  path: string;
  oldCategory: string;
  newCategory: string;
  source: string;
  reason: string;
}

interface CategorizeResult {
  scanned: number;
  eligible: number;
  planned: number;
  applied: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
  plan: PlanEntry[];
  dryRun: boolean;
  overwrite: boolean;
}

/**
 * Decide whether a given note path belongs to the read-write vault. Writes
 * may only target RW; notes in RO vaults are scanned but skipped on write.
 */
function isInRwVault(notePath: string): boolean {
  // notePath is vault-relative (from listFiles) — listFiles only walks the
  // resolved directory, and for the default scope '.' it walks the RW vault.
  // We defensively check by re-resolving when ambiguous.
  const rw = config.brainVault.replace(/\\/g, '/');
  if (!rw) return true;
  // Paths returned by listFiles are relative to the vault they came from;
  // bare relative paths are RW-relative. If the path happens to start with a
  // RO vault prefix, bail.
  for (const ro of config.sourceVaults) {
    const roNorm = ro.replace(/\\/g, '/');
    const roBase = path.basename(roNorm);
    if (notePath.startsWith(roBase + '/') || notePath === roBase) {
      return false;
    }
  }
  return true;
}

export function register(server: McpServer): void {
  server.tool(
    "notes_categorize",
    `Batch-categorize notes in the vault by inferring a concrete frontmatter \`category\` from path, existing frontmatter hints, and content keywords.

Defaults to a dry run — returns the proposed category change per file and never writes until you pass \`dryRun: false\`. Uses ETag-safe writes so concurrent edits are never clobbered.

Typical usage:
  1) \`notes_categorize\` (dry-run the whole vault, review the plan)
  2) \`notes_categorize { dryRun: false }\` (apply)
  3) \`notes_categorize { overwrite: true, dryRun: false }\` (also reassign notes that already have a category — destructive, use with care)`,
    {
      scope: z
        .string()
        .optional()
        .default('.')
        .describe("Vault-relative directory to walk. Defaults to the whole vault."),
      dryRun: z
        .boolean()
        .optional()
        .default(true)
        .describe("When true (default), produce a plan without writing. When false, apply the changes."),
      overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe("When true, also reassign notes that already have a non-empty category. When false (default), only fill in missing categories."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of files to include in the plan / apply. Useful for incremental runs. Unbounded when omitted."),
      pattern: z
        .string()
        .optional()
        .default('**/*.md')
        .describe("Glob pattern for matching files (relative to scope)."),
    },
    wrapToolHandler("notes_categorize", async (params) => {
      const scope = sanitizePath(((params.scope as string) ?? '.') || '.');
      const dryRun = (params.dryRun as boolean | undefined) ?? true;
      const overwrite = (params.overwrite as boolean | undefined) ?? false;
      const limit = params.limit as number | undefined;
      const pattern = (params.pattern as string | undefined) ?? '**/*.md';

      const result: CategorizeResult = {
        scanned: 0,
        eligible: 0,
        planned: 0,
        applied: 0,
        skipped: 0,
        errors: [],
        plan: [],
        dryRun,
        overwrite,
      };

      let files: string[];
      try {
        files = await listFiles(scope, pattern);
      } catch (err) {
        throw new Error(`listFiles failed for scope "${scope}": ${err instanceof Error ? err.message : String(err)}`);
      }

      const docMeta = getDocMeta();

      // Phase A: build the plan from the in-memory docMeta index (no disk
      // reads). `inferNoteCategory` is a cheap pure heuristic that only needs
      // the frontmatter + body, both of which are carried in meta. Files that
      // are not indexed fall back to a disk read for their frontmatter/body.
      for (const notePath of files) {
        if (limit !== undefined && result.plan.length >= limit) break;
        result.scanned++;

        let data: Record<string, any>;
        let body: string;
        const meta = docMeta.get(notePath);
        if (meta) {
          // Reconstruct the fields inferNoteCategory reads from cached meta.
          data = {
            category: meta.category,
            type: meta.type,
            tags: meta.tags,
            title: meta.title,
            temperature: meta.temperature,
          };
          body = meta.content ?? '';
        } else {
          // Unindexed: fall back to a disk read + parse.
          let content: string;
          try {
            const read = await readNote(notePath);
            content = read.content;
          } catch (err) {
            result.errors.push({
              path: notePath,
              error: `read: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
          try {
            ({ data, body } = parseFrontmatter(content));
          } catch (err) {
            result.errors.push({
              path: notePath,
              error: `parse: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
        }

        const existing = typeof data.category === 'string' ? data.category.trim() : '';
        const hasExisting = existing.length > 0;

        if (hasExisting && !overwrite) {
          result.skipped++;
          continue;
        }

        result.eligible++;

        const inferred = inferNoteCategory({
          path: notePath,
          frontmatter: data,
          content: body,
        });
        const newCategory = inferred.category || 'general';

        // Skip no-op reassignments even when overwrite=true.
        if (hasExisting && existing === newCategory) {
          result.skipped++;
          continue;
        }

        const entry: PlanEntry = {
          path: notePath,
          oldCategory: existing || '',
          newCategory,
          source: inferred.source,
          reason: inferred.reason,
        };
        result.plan.push(entry);
        result.planned++;
      }

      // Phase B: apply the plan. Each note is (re-)read fresh for an ETag-safe
      // write, mutated, and written using a bounded-concurrency pool instead of
      // a serial loop. Re-indexing is deferred and batched after the pool
      // drains so we index each changed path exactly once, off the write path.
      if (!dryRun) {
        const changedPaths: string[] = [];
        const failedPaths = new Set<string>();

        await runWithConcurrency(result.plan, 16, async (entry) => {
          const notePath = entry.path;
          if (!isInRwVault(notePath)) {
            result.errors.push({
              path: notePath,
              error: 'skipped: path is in a read-only vault',
            });
            failedPaths.add(notePath);
            return;
          }
          try {
            // Re-read for a fresh ETag + authoritative body/frontmatter.
            const { content, etag } = await readNote(notePath);
            const { data, body } = parseFrontmatter(content);
            data.category = entry.newCategory;
            const updated = stringifyFrontmatter(data, body);
            await writeNote(notePath, updated, etag);
            result.applied++;
            changedPaths.push(notePath);
          } catch (err) {
            result.errors.push({
              path: notePath,
              error: `write: ${err instanceof Error ? err.message : String(err)}`,
            });
            failedPaths.add(notePath);
          }
        });

        // Drop plan entries whose apply failed, keeping planned in sync.
        if (failedPaths.size > 0) {
          result.plan = result.plan.filter((e) => !failedPaths.has(e.path));
          result.planned = result.plan.length;
        }

        // Batched, deferred re-index of the notes we actually changed.
        for (const p of changedPaths) {
          try {
            await indexNote(p);
          } catch (err) {
            logger.warn('notes_categorize: re-index failed', {
              path: p,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      logger.info('notes_categorize complete', {
        scope,
        dryRun,
        overwrite,
        scanned: result.scanned,
        eligible: result.eligible,
        planned: result.planned,
        applied: result.applied,
        errors: result.errors.length,
      });

      const summary = dryRun
        ? `Dry-run: would assign category to ${result.planned} of ${result.scanned} notes (${result.skipped} skipped, ${result.errors.length} errors). Re-run with dryRun:false to apply.`
        : `Applied category to ${result.applied} of ${result.scanned} notes (${result.skipped} skipped, ${result.errors.length} errors).`;

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    })
  );
}
