import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { listPacks, syncDeclaredPack } from '../lib/guidance-packs/store.js';

export function register(server: McpServer): void {
  server.tool(
    'guidance_packs',
    'List installed guidance packs (source, commit, licence, entry count, last sync). Pass sync=<name> to re-fetch an already declared pack; adding/removing packs is an operator action (`cortexmd guidance add|remove`).',
    {
      sync: z.string().optional().describe('Declared pack to re-sync now'),
    },
    wrapToolHandler('guidance_packs', async (params) => {
      const sync = typeof params.sync === 'string' ? params.sync.trim() : '';
      let synced: unknown;
      if (sync) {
        const m = await syncDeclaredPack(sync);
        synced = { name: m.name, commit: m.commit, entries: m.entries, syncedAt: m.syncedAt };
      }
      const packs = await listPacks();
      return {
        _detail: `${packs.filter((p) => p.installed).length} installed${sync ? `, synced ${sync}` : ''}`,
        content: [{ type: 'text' as const, text: JSON.stringify({ packs, ...(synced ? { synced } : {}) }) }],
      };
    }),
  );
}
