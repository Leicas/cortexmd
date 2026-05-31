import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDocMeta, getIndexedNoteCount } from './lib/search.js';
import { getMetrics } from './lib/metrics.js';
import { readNote, listFiles } from './lib/vault.js';
import { parseFrontmatter } from './lib/frontmatter.js';
import { config } from './config.js';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './lib/logger.js';
import { wakeUp } from './lib/memory-stack.js';
import { kgStats } from './lib/knowledge-graph.js';
import { listAgents } from './lib/journal.js';

// ── Materialized view cache ───────────────────────────────────────────
const resourceCache = new Map<string, { data: unknown; expires: number }>();

function getCached<T>(key: string, ttlMs: number, compute: () => T): T {
  const cached = resourceCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data as T;
  const data = compute();
  resourceCache.set(key, { data, expires: Date.now() + ttlMs });
  return data;
}

async function getCachedAsync<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const cached = resourceCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data as T;
  const data = await compute();
  resourceCache.set(key, { data, expires: Date.now() + ttlMs });
  return data;
}

/**
 * Register all MCP resources on the server.
 */
export function registerResources(server: McpServer): void {
  // ── Resource 1: memory://hot-items ──────────────────────────────────
  server.resource(
    'hot-items',
    'memory://hot-items',
    {
      description:
        'Currently hot memories — high activity, recent access, many links',
      mimeType: 'application/json',
    },
    async () => {
      const top = await getCachedAsync('hot-items', 30_000, async () => {
        const items: Array<{
          path: string;
          title: string;
          category: string;
          heat_score: number;
          last_accessed: string | null;
          tags: string[];
        }> = [];

        try {
          const files = await listFiles('.');
          for (const f of files) {
            try {
              const { content } = await readNote(f);
              const { data } = parseFrontmatter(content);

              if (data.temperature !== 'hot' && !(data.heat_score && data.heat_score >= 7)) {
                continue;
              }

              items.push({
                path: f,
                title: data.title || f.replace(/\.md$/, '').split('/').pop() || f,
                category: data.category || data.type || 'unknown',
                heat_score: data.heat_score ?? 7,
                last_accessed: data.last_accessed || data.last_updated || data.updated || null,
                tags: Array.isArray(data.tags) ? data.tags : [],
              });
            } catch {
              // skip unreadable files
            }
          }
        } catch (err) {
          logger.error('hot-items resource: failed to list files', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Sort by heat_score descending, limit to 20
        items.sort((a, b) => b.heat_score - a.heat_score);
        return items.slice(0, 20);
      });

      return {
        contents: [
          {
            uri: 'memory://hot-items',
            mimeType: 'application/json',
            text: JSON.stringify(top, null, 2),
          },
        ],
      };
    },
  );

  // ── Resource 2: memory://recent-memories ────────────────────────────
  server.resource(
    'recent-memories',
    'memory://recent-memories',
    {
      description: 'Most recently created or updated memories',
      mimeType: 'application/json',
    },
    async () => {
      const recentMemories = await getCachedAsync('recent-memories', 60_000, async () => {
        const memories: Array<{
          path: string;
          title: string;
          category: string;
          temperature: string;
          updated: string | null;
        }> = [];

        try {
          const files = await listFiles('.');
          for (const f of files) {
            try {
              const { content } = await readNote(f);
              const { data } = parseFrontmatter(content);

              if (data.type !== 'memory') continue;

              const updated = data.last_updated || data.updated || data.date || data.created || null;
              memories.push({
                path: f,
                title: data.title || f.replace(/\.md$/, '').split('/').pop() || f,
                category: data.category || 'unknown',
                temperature: data.temperature || 'unknown',
                updated,
              });
            } catch {
              // skip
            }
          }
        } catch (err) {
          logger.error('recent-memories resource: failed to list files', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Sort by updated date descending (nulls last)
        memories.sort((a, b) => {
          if (!a.updated && !b.updated) return 0;
          if (!a.updated) return 1;
          if (!b.updated) return -1;
          return b.updated.localeCompare(a.updated);
        });

        return memories.slice(0, 20);
      });

      return {
        contents: [
          {
            uri: 'memory://recent-memories',
            mimeType: 'application/json',
            text: JSON.stringify(recentMemories, null, 2),
          },
        ],
      };
    },
  );

  // ── Resource 3: memory://open-tasks ─────────────────────────────────
  server.resource(
    'open-tasks',
    'memory://open-tasks',
    {
      description: 'All open tasks across the vault',
      mimeType: 'application/json',
    },
    async () => {
      const openTasks = await getCachedAsync('open-tasks', 60_000, async () => {
        const tasks: Array<{
          path: string;
          title: string;
          taskLines: string[];
        }> = [];

        try {
          const files = await listFiles('.');
          for (const f of files) {
            try {
              const { content } = await readNote(f);
              const { data, body } = parseFrontmatter(content);

              // Extract lines with unchecked task markers
              const lines = body.split('\n');
              const openTaskLines = lines
                .map((l) => l.trim())
                .filter((l) => l.startsWith('- [ ]'));

              if (openTaskLines.length === 0) continue;

              tasks.push({
                path: f,
                title: data.title || f.replace(/\.md$/, '').split('/').pop() || f,
                taskLines: openTaskLines,
              });
            } catch {
              // skip
            }
          }
        } catch (err) {
          logger.error('open-tasks resource: failed to list files', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        return tasks;
      });

      return {
        contents: [
          {
            uri: 'memory://open-tasks',
            mimeType: 'application/json',
            text: JSON.stringify(openTasks, null, 2),
          },
        ],
      };
    },
  );

  // ── Resource 4: memory://vault-schema ───────────────────────────────
  server.resource(
    'vault-schema',
    'memory://vault-schema',
    {
      description:
        'Machine-readable description of vault conventions, frontmatter schema, tools, and folder structure — helps first-time agents create well-formed notes',
      mimeType: 'application/json',
    },
    async () => {
      const schema = getCached('vault-schema', 300_000, () => ({
        memoryCategories: [
          'observation',
          'decision',
          'insight',
          'conversation',
          'fact',
          'preference',
          'plan',
          'reflection',
        ],
        memoryDirectoryPattern: 'Memories/{category}/[YYYY/MM/]YYYY-MM-DD-{slug}.md (temporal categories get year/month subfolders; facts and preferences stay flat)',
        frontmatterSchema: {
          id: 'uuid — auto-generated',
          type: 'memory | task | project | person | org',
          category: 'one of memoryCategories (for type=memory)',
          title: 'string — note title',
          tags: 'string[] — free-form tags',
          importance: 'low | medium | high | critical',
          temperature: 'hot | warm | cold — auto-computed',
          heat_score: 'number 0-16 — auto-computed',
          access_count: 'number — incremented on read',
          last_accessed: 'YYYY-MM-DD — updated on read',
          created: 'YYYY-MM-DD',
          last_updated: 'YYYY-MM-DD',
          related: 'string[] — wikilinks to related notes',
          archived: 'boolean',
          consolidated_into: 'string — wikilink if consolidated',
        },
        temperatureThresholds: {
          hot: 'heat_score >= 10',
          warm: 'heat_score >= 4',
          cold: 'heat_score < 4',
        },
        vaults: {
          brain: config.brainVault,
          source: config.sourceVaults,
        },
        folderStructure: {
          Projects: 'Project notes and portfolios (also matches 01 Projects)',
          CRM: 'Entity notes (people, orgs), inbox (also matches 05 CRM)',
          Memories: 'AI memories by category, temporal ones in YYYY/MM subfolders',
          Journal: 'Daily journal files (Journal/YYYY/MM/YYYY-MM-DD.md)',
          Ops: 'Agent diaries, reports, system config (also matches 99 Ops)',
          Knowledge: 'Reference material and KB articles',
          Archive: 'Archived/consolidated notes',
        },
        tools: {
          memory_store: 'Create a new categorized memory',
          memory_recall: 'Smart search with temperature/importance boosting',
          memory_consolidate: 'Merge related memories into summaries',
          notes_search: 'Full-text search with frontmatter filters',
          notes_get: 'Read a note (promotes temperature on access)',
          notes_upsert: 'Create/update notes (replace, append, section-merge)',
          notes_list: 'List notes with filters and pagination',
          notes_archive: 'Soft-delete a note',
          tags_list: 'List all tags with counts',
          graph_neighbors: 'Explore note relationships',
          journal_append: 'Add timestamped journal entries',
          tasks_create_or_update: 'Create/update tasks',
          tasks_resolve: 'Mark tasks done',
          brief_daily: 'Generate daily briefings',
          memory_temperature_refresh: 'Recompute temperature scores',
          artifact_ingest: 'Ingest images/audio/URLs',
          notes_link_entities: 'Link person/org/project entities',
          memory_dream: 'Run dream cycle — theme detection, orphan finding, connection suggestions, consolidation',
          memory_promote: 'Manually promote/demote memory temperature (boost, cool, freeze, archive, unarchive)',
        },
      }));

      return {
        contents: [
          {
            uri: 'memory://vault-schema',
            mimeType: 'application/json',
            text: JSON.stringify(schema, null, 2),
          },
        ],
      };
    },
  );

  // ── Resource 5: memory://vault-stats ────────────────────────────────
  server.resource(
    'vault-stats',
    'memory://vault-stats',
    {
      description:
        'Vault statistics — note counts, temperature distribution, tag cloud',
      mimeType: 'application/json',
    },
    async () => {
      const stats = await getCachedAsync('vault-stats', 30_000, async () => {
        const docMeta = getDocMeta();
        const metrics = getMetrics();

        let hotCount = 0;
        let warmCount = 0;
        let coldCount = 0;
        const tagCounts = new Map<string, number>();

        // We scan vault files to get accurate temperature data from frontmatter
        try {
          const files = await listFiles('.');
          for (const f of files) {
            try {
              const { content } = await readNote(f);
              const { data } = parseFrontmatter(content);

              // Temperature counts
              if (data.temperature === 'hot') hotCount++;
              else if (data.temperature === 'warm') warmCount++;
              else if (data.temperature === 'cold') coldCount++;

              // Aggregate tags
              const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
              for (const tag of tags) {
                tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
              }
            } catch {
              // skip
            }
          }
        } catch {
          // If file scan fails, fall back to docMeta from index
          for (const [, meta] of docMeta) {
            for (const tag of meta.tags) {
              tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
            }
          }
        }

        // Top 20 tags sorted by frequency descending
        const topTags = [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([tag, count]) => ({ tag, count }));

        return {
          totalNotes: getIndexedNoteCount(),
          hotCount,
          warmCount,
          coldCount,
          topTags,
          lastIndexRebuild: metrics.lastIndexRebuild,
        };
      });

      return {
        contents: [
          {
            uri: 'memory://vault-stats',
            mimeType: 'application/json',
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    },
  );

  // ── Resource 6: memory://wakeup ──────────────────────────────────────
  server.resource(
    'wakeup',
    'memory://wakeup',
    {
      description:
        'Wake-up context: identity (L0) + essential narrative (L1) for quick orientation',
      mimeType: 'application/json',
    },
    async () => {
      const layers = await getCachedAsync('wakeup', 30_000, async () => {
        const result = await wakeUp();
        const totalTokens = result.reduce((sum, l) => sum + l.tokens, 0);
        return { layers: result, totalTokens };
      });

      return {
        contents: [
          {
            uri: 'memory://wakeup',
            mimeType: 'application/json',
            text: JSON.stringify(layers, null, 2),
          },
        ],
      };
    },
  );

  // ── Resource 7: knowledge://stats ────────────────────────────────────
  server.resource(
    'knowledge-stats',
    'knowledge://stats',
    {
      description:
        'Knowledge graph statistics (entities, triples, predicates)',
      mimeType: 'application/json',
    },
    async () => {
      let data: unknown;
      try {
        data = kgStats();
      } catch {
        data = { status: 'not_initialized', message: 'KG not enabled or not initialized' };
      }

      return {
        contents: [
          {
            uri: 'knowledge://stats',
            mimeType: 'application/json',
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // ── Resource 8: memory://agents ──────────────────────────────────────
  server.resource(
    'agents',
    'memory://agents',
    {
      description:
        'Known AI agents with last-active time and diary entry count',
      mimeType: 'application/json',
    },
    async () => {
      let agents: unknown[];
      try {
        agents = await listAgents();
      } catch {
        agents = [];
      }

      return {
        contents: [
          {
            uri: 'memory://agents',
            mimeType: 'application/json',
            text: JSON.stringify({ agents }, null, 2),
          },
        ],
      };
    },
  );
}
