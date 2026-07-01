import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote, resolveSafePathForRead } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { buildLinkGraph } from '../lib/graph.js';
import { getDocMeta } from '../lib/search.js';
import { appendJournalEntry } from '../lib/journal.js';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { decayMemories, autoArchiveColdMemories } from '../lib/memory-lifecycle.js';
import { computeHeatScore } from '../lib/memory.js';
import { classifyPath } from '../lib/collections.js';
import { lstat } from 'node:fs/promises';

interface ScoredNote {
  path: string;
  title: string;
  heatScore: number;
  temperature: 'hot' | 'warm' | 'cold';
}

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

export function register(server: McpServer): void {
  server.tool(
    "memory_temperature_refresh",
    "Scan all vault notes and compute heat scores based on recency, links, and open tasks",
    {
      writeFrontmatter: z.boolean().optional().default(false).describe("Whether to update temperature and heat_score in each note's frontmatter"),
      decayAndArchive: z.boolean().optional().default(false).describe("Whether to also run decay and auto-archive after computing scores"),
      scope: z
        .enum(['memories', 'vault'])
        .optional()
        .default('memories')
        .describe("Which notes to refresh. 'memories' (default) only touches Memories/ notes; 'vault' applies the lifecycle to every collection — useful to backfill heat_score / temperature on notes that were never categorised."),
    },
    wrapToolHandler("memory_temperature_refresh", async (params) => {
      const writeFrontmatter = params.writeFrontmatter as boolean | undefined;
      const doDecayAndArchive = params.decayAndArchive as boolean | undefined;
      const scope = (params.scope as 'memories' | 'vault' | undefined) ?? 'memories';
      const now = Date.now();

      // Build the link graph for incoming link counts
      const linkGraph = await buildLinkGraph();
      const incomingCounts = new Map<string, number>();
      for (const [_source, targets] of linkGraph) {
        for (const target of targets) {
          incomingCounts.set(target, (incomingCounts.get(target) ?? 0) + 1);
        }
      }

      const docMeta = getDocMeta();

      // Find open tasks for cross-referencing. Candidate task paths come from
      // the in-memory docMeta index (meta.type === 'task') instead of a
      // separate full-vault search; we then read only those (bounded pool) to
      // confirm status, rather than reading up to 200 search hits serially.
      const openTaskPaths = new Set<string>();
      const taskCandidates: string[] = [];
      for (const [p, meta] of docMeta) {
        if (meta.type === 'task') taskCandidates.push(p);
      }
      await runWithConcurrency(taskCandidates, 16, async (p) => {
        try {
          const { content } = await readNote(p);
          const { data } = parseFrontmatter(content);
          if (data.type === 'task' && data.status === 'open') {
            openTaskPaths.add(p);
          }
        } catch {
          // skip
        }
      });

      // Scan notes in the vault. When scope === 'memories' we keep the legacy
      // behaviour (only Memories/*). When scope === 'vault' we walk the whole
      // vault so every collection gets a concrete temperature + heat_score.
      // The candidate set is derived from docMeta (in-memory) rather than a
      // fresh listFiles walk; heat scoring still needs frontmatter fields not
      // carried in meta (last_updated, access_count, status), so we read those
      // notes with a bounded-concurrency pool instead of a serial loop, and
      // batch the frontmatter writes at the end.
      const scanPaths: string[] = [];
      for (const [f, meta] of docMeta) {
        const collection = meta.collection ?? classifyPath(f);
        if (scope === 'memories' && collection !== 'memories') continue;
        scanPaths.push(f);
      }

      const scored: ScoredNote[] = [];
      const pendingWrites: Array<{ path: string; content: string }> = [];

      await runWithConcurrency(scanPaths, 16, async (f) => {
        try {
          const { content } = await readNote(f);
          const { data, body } = parseFrontmatter(content);

          // Get file modification time as fallback for notes without last_updated
          let fileMtimeMs: number | undefined;
          if (!data.last_updated) {
            try {
              const resolved = await resolveSafePathForRead(f);
              const stats = await lstat(resolved);
              fileMtimeMs = stats.mtimeMs;
            } catch {
              // ignore stat errors
            }
          }

          // Use canonical heat score computation from memory.ts
          const linkCount = incomingCounts.get(f) ?? 0;
          const outgoing = linkGraph.get(f) ?? [];
          const hasOpenTask = outgoing.some((t) => openTaskPaths.has(t));

          const { score, temperature } = computeHeatScore(data, {
            incomingLinkCount: linkCount,
            hasOpenTask,
            fileMtimeMs,
            now,
          });

          const title = data.title || f.replace(/\.md$/, '').split('/').pop() || f;

          scored.push({ path: f, title, heatScore: score, temperature });

          // Defer the frontmatter write so all disk writes are batched after
          // the scan pool drains.
          if (writeFrontmatter) {
            if (data.temperature !== temperature || data.heat_score !== score) {
              data.temperature = temperature;
              data.heat_score = score;
              data.last_temp_refresh = new Date().toISOString().slice(0, 10);
              const updated = stringifyFrontmatter(data, body);
              pendingWrites.push({ path: f, content: updated });
            }
          }
        } catch {
          // skip unreadable files
        }
      });

      // Batched frontmatter writes (bounded concurrency).
      if (pendingWrites.length > 0) {
        await runWithConcurrency(pendingWrites, 16, async (w) => {
          try {
            await writeNote(w.path, w.content);
          } catch {
            // skip unwritable files
          }
        });
      }

      // Count by temperature
      const counts = {
        hot: scored.filter((s) => s.temperature === 'hot').length,
        warm: scored.filter((s) => s.temperature === 'warm').length,
        cold: scored.filter((s) => s.temperature === 'cold').length,
      };

      await appendJournalEntry(
        `Memory temperature refresh (scope=${scope}): ${counts.hot} hot, ${counts.warm} warm, ${counts.cold} cold`,
      );

      // Optionally run decay and auto-archive
      let decayResult: { decayed: number } | undefined;
      let archiveResult: { archived: string[] } | undefined;
      if (doDecayAndArchive) {
        decayResult = await decayMemories();
        archiveResult = await autoArchiveColdMemories();
      }

      const response: Record<string, any> = { scope, counts };
      if (decayResult) {
        response.decayed = decayResult.decayed;
      }
      if (archiveResult) {
        response.autoArchived = archiveResult.archived.length;
        response.autoArchivedPaths = archiveResult.archived;
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(response),
        }],
      };
    })
  );
}
