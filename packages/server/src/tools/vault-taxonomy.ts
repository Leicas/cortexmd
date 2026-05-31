import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { getDocMeta } from '../lib/search.js';
import { classifyPath } from '../lib/collections.js';
import { getGraphStats } from '../lib/graph.js';
import { isKgInitialized, kgStats } from '../lib/knowledge-graph.js';

interface RoomInfo {
  name: string;
  drawerCount: number;
  hotCount: number;
  categories: Record<string, number>;
}

interface WingInfo {
  name: string;
  drawerCount: number;
  rooms: RoomInfo[];
  topTags: Array<{ tag: string; count: number }>;
}

/**
 * Extract the "room" from a note path within its wing/collection.
 * Room = first subfolder within the collection, or frontmatter category for flat collections.
 */
function detectRoom(notePath: string, collection: string, category?: string): string {
  // Strip the collection prefix pattern to get the relative path within the wing
  const prefixes: Record<string, RegExp> = {
    memories: /^Memories\//i,
    journal: /^Journal\//i,
    projects: /^(Projects|01 Projects|03 Projects)\//i,
    crm: /^(CRM|05 CRM)\//i,
    knowledge: /^(Knowledge|10 Knowledge Base|06 Intelligence)\//i,
    ops: /^(Ops|99 Ops)\//i,
    'daily-notes': /^DailyNotes\//i,
    archive: /^(Archive|04 Archive)\//i,
  };

  const prefix = prefixes[collection];
  let relative = notePath;
  if (prefix) {
    relative = notePath.replace(prefix, '');
  }

  // First subfolder = room
  const slash = relative.indexOf('/');
  if (slash > 0) {
    return relative.slice(0, slash);
  }

  // No subfolder — use category if available, otherwise "root"
  return category ?? 'root';
}

export function register(server: McpServer): void {
  server.tool(
    'vault_taxonomy',
    `Navigate the vault hierarchy as Wings → Rooms → Drawers (mempalace-style taxonomy).

Wings = collections (memories, projects, crm, ops, etc.).
Rooms = subfolders or categories within each wing.
Drawers = individual notes.
Tunnels = wiki-links that bridge notes across different wings.

Use wing filter to zoom into a specific collection. Use this tool to discover what's in the vault before searching.`,
    {
      wing: z
        .string()
        .optional()
        .describe('Filter to a specific wing/collection (e.g. "memories", "projects", "crm"). Omit for full taxonomy.'),
      includeRooms: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include room-level breakdown within each wing (default: true)'),
      includeTunnels: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include tunnel detection — rooms/tags that bridge multiple wings (slower)'),
    },
    wrapToolHandler('vault_taxonomy', async (params) => {
      const wingFilter = params.wing as string | undefined;
      const includeRooms = (params.includeRooms as boolean | undefined) ?? true;
      const includeTunnels = (params.includeTunnels as boolean | undefined) ?? false;

      const docMeta = getDocMeta();

      // Build wing → room → drawer tree
      const wingMap = new Map<string, {
        drawers: number;
        hot: number;
        rooms: Map<string, { count: number; hot: number; categories: Record<string, number> }>;
        tags: Map<string, number>;
      }>();

      for (const [notePath, meta] of docMeta) {
        const wing = meta.collection ?? classifyPath(notePath);
        if (wingFilter && wing !== wingFilter) continue;

        let wingData = wingMap.get(wing);
        if (!wingData) {
          wingData = { drawers: 0, hot: 0, rooms: new Map(), tags: new Map() };
          wingMap.set(wing, wingData);
        }

        wingData.drawers++;
        if (meta.temperature === 'hot') wingData.hot++;

        // Room classification
        if (includeRooms) {
          const room = detectRoom(notePath, wing, meta.category);
          let roomData = wingData.rooms.get(room);
          if (!roomData) {
            roomData = { count: 0, hot: 0, categories: {} };
            wingData.rooms.set(room, roomData);
          }
          roomData.count++;
          if (meta.temperature === 'hot') roomData.hot++;
          if (meta.category) {
            roomData.categories[meta.category] = (roomData.categories[meta.category] ?? 0) + 1;
          }
        }

        // Tag aggregation
        for (const tag of meta.tags) {
          wingData.tags.set(tag, (wingData.tags.get(tag) ?? 0) + 1);
        }
      }

      // Build output
      const wings: WingInfo[] = [];
      for (const [name, data] of wingMap) {
        const rooms: RoomInfo[] = [];
        if (includeRooms) {
          for (const [roomName, roomData] of data.rooms) {
            rooms.push({
              name: roomName,
              drawerCount: roomData.count,
              hotCount: roomData.hot,
              categories: roomData.categories,
            });
          }
          rooms.sort((a, b) => b.drawerCount - a.drawerCount);
        }

        const topTags = [...data.tags.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([tag, count]) => ({ tag, count }));

        wings.push({
          name,
          drawerCount: data.drawers,
          rooms: includeRooms ? rooms : [],
          topTags,
        });
      }
      wings.sort((a, b) => b.drawerCount - a.drawerCount);

      // Tunnel detection: tags or room names that appear in 2+ wings
      let tunnels: Array<{ name: string; type: 'room' | 'tag'; wings: string[]; drawerCount: number }> | undefined;
      if (includeTunnels) {
        // Room tunnels: same room name in different wings
        const roomToWings = new Map<string, Set<string>>();
        const roomTotalCount = new Map<string, number>();
        for (const wing of wings) {
          for (const room of wing.rooms) {
            const roomSet = roomToWings.get(room.name) ?? new Set();
            roomSet.add(wing.name);
            roomToWings.set(room.name, roomSet);
            roomTotalCount.set(room.name, (roomTotalCount.get(room.name) ?? 0) + room.drawerCount);
          }
        }

        // Tag tunnels: same tag in different wings
        const tagToWings = new Map<string, Set<string>>();
        const tagTotalCount = new Map<string, number>();
        for (const wing of wings) {
          for (const { tag, count } of wing.topTags) {
            const tagSet = tagToWings.get(tag) ?? new Set();
            tagSet.add(wing.name);
            tagToWings.set(tag, tagSet);
            tagTotalCount.set(tag, (tagTotalCount.get(tag) ?? 0) + count);
          }
        }

        tunnels = [];
        for (const [name, wingSet] of roomToWings) {
          if (wingSet.size >= 2 && name !== 'root') {
            tunnels.push({ name, type: 'room', wings: [...wingSet], drawerCount: roomTotalCount.get(name) ?? 0 });
          }
        }
        for (const [name, wingSet] of tagToWings) {
          if (wingSet.size >= 2) {
            tunnels.push({ name, type: 'tag', wings: [...wingSet], drawerCount: tagTotalCount.get(name) ?? 0 });
          }
        }
        tunnels.sort((a, b) => b.wings.length - a.wings.length || b.drawerCount - a.drawerCount);
        tunnels = tunnels.slice(0, 20);
      }

      // Halls = memory category distribution across the entire vault
      const halls: Record<string, number> = {};
      for (const [, meta] of docMeta) {
        if (wingFilter && (meta.collection ?? classifyPath('')) !== wingFilter) continue;
        if (meta.category) {
          halls[meta.category] = (halls[meta.category] ?? 0) + 1;
        }
      }

      // Graph + KG summary for context
      const graphStats = getGraphStats();
      let kgSummary: { entities: number; triples: number } | null = null;
      if (isKgInitialized()) {
        const kg = kgStats();
        kgSummary = { entities: kg.entityCount, triples: kg.tripleCount };
      }

      const totalDrawers = wings.reduce((sum, w) => sum + w.drawerCount, 0);

      const result = {
        totalDrawers,
        wingCount: wings.length,
        wings,
        halls,
        tunnels: tunnels ?? undefined,
        graph: graphStats ? {
          totalLinks: graphStats.totalLinks,
          orphanNotes: graphStats.orphanNotes,
        } : null,
        knowledgeGraph: kgSummary,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }),
  );
}
