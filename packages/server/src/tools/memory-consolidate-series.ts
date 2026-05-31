import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote, deleteNote } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { getDocMeta, indexNote, removeFromIndex } from '../lib/search.js';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { recordConsolidation } from '../lib/metrics.js';
import { logger } from '../lib/logger.js';

/**
 * Compute ISO week number (1-53) for a date. Folds all older series entries
 * into the current week's rolling summary note. Uses ISO-8601 week-date.
 */
function isoWeek(date: Date): { year: number; week: number } {
  // Copy date so don't modify original
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function formatWeekTag(d: Date): string {
  const { year, week } = isoWeek(d);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function sortableDate(meta: { date?: string; last_accessed?: string }): number {
  const raw = meta.date || meta.last_accessed;
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  return isNaN(t) ? 0 : t;
}

function slugifyTag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untagged';
}

export function register(server: McpServer): void {
  server.tool(
    'memory_consolidate_series',
    "Fold older memory notes in a tagged time-series (e.g. cron logs, heartbeat notes, email recaps) into a single rolling weekly summary at Memories/consolidated/{tag}-{YYYY-Www}.md. Keeps the most recent N notes untouched. Default dryRun=true returns a plan with counts and target paths; dryRun=false performs the fold (append to the weekly file, delete originals). Safe by default.",
    {
      tag: z.string().min(1).describe("Required. Tag that identifies the series (e.g. 'cron-run', 'email-recap')."),
      titleTemplate: z.string().optional().describe("Optional regex applied to note titles for additional matching (e.g. '^Cron run '). Combined with tag match (both must pass)."),
      keepLast: z.number().int().min(0).max(1000).optional().describe("How many most-recent notes to leave untouched. Default 1."),
      dryRun: z.boolean().optional().describe("If true (default), returns the plan without modifying the vault."),
    },
    wrapToolHandler('memory_consolidate_series', async (params) => {
      const tag = params.tag as string;
      const titleTemplateRaw = params.titleTemplate as string | undefined;
      const keepLast = (params.keepLast as number | undefined) ?? 1;
      const dryRun = (params.dryRun as boolean | undefined) ?? true;

      let titleRegex: RegExp | undefined;
      if (titleTemplateRaw) {
        try {
          titleRegex = new RegExp(titleTemplateRaw);
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `Invalid titleTemplate regex: ${err instanceof Error ? err.message : String(err)}` }) }],
          };
        }
      }

      // 1. Collect matching notes from the index
      const dm = getDocMeta();
      type Candidate = { path: string; title: string; dateMs: number; tags: string[] };
      const matches: Candidate[] = [];
      for (const [p, meta] of dm) {
        if (!meta.tags.includes(tag)) continue;
        if (titleRegex && !titleRegex.test(meta.title)) continue;
        // Skip already-consolidated targets to prevent folding a rolling note into itself
        if (p.startsWith('Memories/consolidated/')) continue;
        matches.push({
          path: p,
          title: meta.title,
          dateMs: sortableDate(meta),
          tags: meta.tags,
        });
      }

      // Sort newest-first so we can peel off `keepLast` most-recent easily
      matches.sort((a, b) => b.dateMs - a.dateMs);

      const toKeep = matches.slice(0, keepLast);
      const toFold = matches.slice(keepLast);

      // 2. Group folds by ISO week
      const weekGroups = new Map<string, Candidate[]>();
      for (const c of toFold) {
        const d = c.dateMs > 0 ? new Date(c.dateMs) : new Date();
        const weekTag = formatWeekTag(d);
        const bucketKey = `${slugifyTag(tag)}-${weekTag}`;
        let list = weekGroups.get(bucketKey);
        if (!list) {
          list = [];
          weekGroups.set(bucketKey, list);
        }
        list.push(c);
      }

      const plan: Array<{
        targetPath: string;
        weekBucket: string;
        foldCount: number;
        sourcePaths: string[];
      }> = [];
      for (const [bucketKey, group] of weekGroups) {
        plan.push({
          targetPath: `Memories/consolidated/${bucketKey}.md`,
          weekBucket: bucketKey,
          foldCount: group.length,
          sourcePaths: group.map((g) => g.path),
        });
      }

      if (dryRun) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              dryRun: true,
              tag,
              titleTemplate: titleTemplateRaw ?? null,
              keepLast,
              totalMatches: matches.length,
              kept: toKeep.map((k) => k.path),
              plan,
              note: 'Re-run with dryRun=false to apply.',
            }, null, 2),
          }],
        };
      }

      // 3. Apply the fold
      const applied: Array<{ targetPath: string; folded: number; deleted: number; errors: string[] }> = [];
      let totalFolded = 0;
      let totalDeleted = 0;

      for (const [bucketKey, group] of weekGroups) {
        const targetPath = `Memories/consolidated/${bucketKey}.md`;
        const errors: string[] = [];
        let folded = 0;
        let deleted = 0;

        // Read existing target if present; otherwise create fresh frontmatter
        let existingData: Record<string, any> = {};
        let existingBody = '';
        let existingSources: string[] = [];
        try {
          const { content } = await readNote(targetPath);
          const parsed = parseFrontmatter(content);
          existingData = parsed.data;
          existingBody = parsed.body;
          if (Array.isArray(parsed.data.consolidated_from)) {
            existingSources = parsed.data.consolidated_from;
          }
        } catch {
          // fresh file
        }

        // Build the per-fold content chunks
        const chunks: string[] = [];
        const foldedSources: string[] = [];
        for (const src of group) {
          try {
            const { content } = await readNote(src.path);
            const { data, body } = parseFrontmatter(content);
            const when = data.date || data.last_accessed || data.created || '';
            const heading = `### ${src.title}${when ? ` — ${when}` : ''}`;
            const pathRef = `*Folded from [[${src.path}]]*`;
            const trimmedBody = body.trim();
            chunks.push(`${heading}\n\n${pathRef}\n\n${trimmedBody}\n`);
            foldedSources.push(src.path);
            folded++;
          } catch (err) {
            errors.push(`read ${src.path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (chunks.length === 0) {
          applied.push({ targetPath, folded: 0, deleted: 0, errors });
          continue;
        }

        const todayStr = new Date().toISOString().slice(0, 10);
        const mergedSources = Array.from(new Set([...existingSources, ...foldedSources]));

        const newData: Record<string, any> = {
          ...existingData,
          title: existingData.title || `${tag} — ${bucketKey}`,
          category: existingData.category || 'insight',
          tags: Array.from(new Set([...(Array.isArray(existingData.tags) ? existingData.tags : []), tag, 'consolidated-series'])).sort(),
          consolidated_from: mergedSources,
          series_tag: tag,
          last_updated: todayStr,
          last_accessed: todayStr,
        };
        if (!existingData.created) newData.created = todayStr;

        const separator = existingBody.trim() ? '\n\n---\n\n' : '\n';
        const appendedBlock = `## Fold ${todayStr} (${chunks.length} entries)\n\n${chunks.join('\n---\n\n')}`;
        const mergedBody = `${existingBody.trimEnd()}${separator}${appendedBlock}\n`;

        try {
          const finalContent = stringifyFrontmatter(newData, mergedBody);
          await writeNote(targetPath, finalContent);
          await indexNote(targetPath);
        } catch (err) {
          errors.push(`write ${targetPath}: ${err instanceof Error ? err.message : String(err)}`);
          applied.push({ targetPath, folded, deleted: 0, errors });
          continue;
        }

        // Delete originals only once the summary write succeeded
        for (const src of group) {
          if (!foldedSources.includes(src.path)) continue;
          try {
            await deleteNote(src.path);
            removeFromIndex(src.path);
            deleted++;
          } catch (err) {
            errors.push(`delete ${src.path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        recordConsolidation(folded);
        applied.push({ targetPath, folded, deleted, errors });
        totalFolded += folded;
        totalDeleted += deleted;
      }

      try {
        await appendJournalEntry(
          `Series consolidation (tag=${tag}): folded ${totalFolded} notes into ${applied.length} weekly summaries, deleted ${totalDeleted} originals`,
        );
      } catch (err) {
        logger.warn('memory_consolidate_series: journal append failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            dryRun: false,
            tag,
            titleTemplate: titleTemplateRaw ?? null,
            keepLast,
            totalMatches: matches.length,
            kept: toKeep.map((k) => k.path),
            totalFolded,
            totalDeleted,
            results: applied,
          }, null, 2),
        }],
      };
    })
  );
}
