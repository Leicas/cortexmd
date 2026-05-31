import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readNote, writeNote, listFiles, resolveSafePathForRead } from '../lib/vault.js';
import { parseFrontmatter, stringifyFrontmatter } from '../lib/frontmatter.js';
import { buildLinkGraph } from '../lib/graph.js';
import { searchNotes } from '../lib/search.js';
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

      // Find open tasks for cross-referencing
      const openTaskPaths = new Set<string>();
      try {
        const taskResults = searchNotes('task', { limit: 200 });
        for (const r of taskResults) {
          try {
            const { content } = await readNote(r.path);
            const { data } = parseFrontmatter(content);
            if (data.type === 'task' && data.status === 'open') {
              openTaskPaths.add(r.path);
            }
          } catch {
            // skip
          }
        }
      } catch {
        // search index not ready
      }

      // Scan notes in the vault. When scope === 'memories' we keep the legacy
      // behaviour (only Memories/*). When scope === 'vault' we walk the whole
      // vault so every collection gets a concrete temperature + heat_score.
      const files = await listFiles('.');
      const scored: ScoredNote[] = [];

      for (const f of files) {
        if (scope === 'memories' && classifyPath(f) !== 'memories') continue;
        try {
          const { content } = await readNote(f);
          const { data } = parseFrontmatter(content);

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

          // Optionally write frontmatter
          if (writeFrontmatter) {
            if (data.temperature !== temperature || data.heat_score !== score) {
              data.temperature = temperature;
              data.heat_score = score;
              data.last_temp_refresh = new Date().toISOString().slice(0, 10);
              const { body } = parseFrontmatter(content);
              const updated = stringifyFrontmatter(data, body);
              await writeNote(f, updated);
            }
          }
        } catch {
          // skip unreadable files
        }
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
