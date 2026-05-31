import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { lstat } from 'node:fs/promises';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import {
  buildAndCacheGraph,
  getInboundLinkCounts,
  getOutgoingLinkCounts,
} from '../lib/graph.js';
import { getDocMeta } from '../lib/search.js';
import { resolveSafePathForRead } from '../lib/vault.js';

interface OrphanResult {
  path: string;
  title: string;
  heat_score: number;
  temperature: string;
  age_days: number;
  outgoing_link_count: number;
}

export function register(server: McpServer): void {
  server.tool(
    'graph_orphans',
    `List notes with zero inbound wiki-links — candidates for archival or better integration.

Returns notes sorted coldest-first (best archive candidates at the top). Optional filters:
- minAge: only include notes older than this many days (skips recent notes still being worked on)
- maxHeat: only include notes with heat_score <= this value
- scopePaths: only include notes whose path starts with one of these prefixes

Each result includes heat_score, temperature, age in days, and outgoing link count so the caller can decide between archival, merging, or adding inbound links.`,
    {
      minAge: z
        .number()
        .optional()
        .describe('Skip notes younger than this many days (default: 0)'),
      maxHeat: z
        .number()
        .optional()
        .describe('Only include notes with heat_score at or below this value'),
      scopePaths: z
        .array(z.string())
        .optional()
        .describe('Only include notes whose path starts with one of these prefixes'),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe('Maximum number of results to return (default: 100)'),
    },
    wrapToolHandler('graph_orphans', async (params) => {
      const minAge = (params.minAge as number | undefined) ?? 0;
      const maxHeat = params.maxHeat as number | undefined;
      const scopePaths = params.scopePaths as string[] | undefined;
      const limit = (params.limit as number | undefined) ?? 100;

      // Ensure the graph is built
      let inbound = getInboundLinkCounts();
      let outgoing = getOutgoingLinkCounts();
      if (!inbound || !outgoing) {
        await buildAndCacheGraph();
        inbound = getInboundLinkCounts();
        outgoing = getOutgoingLinkCounts();
      }
      if (!inbound || !outgoing) {
        throw new Error('Graph cache unavailable');
      }

      const docMeta = getDocMeta();
      const now = Date.now();
      const DAY = 86_400_000;

      const orphans: OrphanResult[] = [];

      for (const filePath of inbound.keys()) {
        const inboundCount = inbound.get(filePath) ?? 0;
        if (inboundCount > 0) continue;

        // Scope filter
        if (scopePaths && scopePaths.length > 0) {
          const matches = scopePaths.some((p) => filePath.startsWith(p));
          if (!matches) continue;
        }

        const meta = docMeta.get(filePath);
        // Skip archived notes — they're already handled
        if (meta?.archived === true) continue;

        const heatScore = typeof meta?.heat_score === 'number' ? meta.heat_score : 0;
        if (maxHeat !== undefined && heatScore > maxHeat) continue;

        // Compute age in days. Prefer frontmatter `date`, fall back to mtime.
        let ageMs: number | undefined;
        if (meta?.date) {
          const ts = new Date(meta.date).getTime();
          if (!isNaN(ts)) ageMs = now - ts;
        }
        if (ageMs === undefined) {
          try {
            const resolved = await resolveSafePathForRead(filePath);
            const stats = await lstat(resolved);
            ageMs = now - stats.mtimeMs;
          } catch {
            continue; // unreadable; skip
          }
        }
        const ageDays = Math.floor(ageMs / DAY);
        if (ageDays < minAge) continue;

        const title =
          meta?.title ||
          filePath.replace(/\.md$/, '').split('/').pop() ||
          filePath;

        orphans.push({
          path: filePath,
          title,
          heat_score: heatScore,
          temperature: meta?.temperature ?? 'cold',
          age_days: ageDays,
          outgoing_link_count: outgoing.get(filePath) ?? 0,
        });
      }

      // Sort coldest-first (heat ascending, then age descending as tiebreaker)
      orphans.sort((a, b) => {
        if (a.heat_score !== b.heat_score) return a.heat_score - b.heat_score;
        return b.age_days - a.age_days;
      });

      const total = orphans.length;
      const sliced = orphans.slice(0, limit);

      const summary =
        `Found ${total} orphan notes (no inbound wiki-links)` +
        (total > sliced.length ? ` — showing ${sliced.length} coldest` : '') +
        '.';

      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\n${JSON.stringify(
              { total, orphans: sliced },
              null,
              2,
            )}`,
          },
        ],
      };
    }),
  );
}
