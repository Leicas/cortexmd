import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { wakeUp, filteredRecall } from '../lib/memory-stack.js';
import type { MemoryLayer } from '../lib/memory-stack.js';
import { getCollectionNames } from '../lib/collections.js';
import { readAgentDiary, listAgents } from '../lib/journal.js';

export function register(server: McpServer): void {
  server.tool(
    'memory_wakeup',
    `Progressive memory retrieval for conversation start. Loads:
- L0: Vault identity (note count, collections overview)
- L1: Top memories by heat score across collections
- L2 (optional): Filtered recall for a specific collection
- Agent diary: Recent entries from your diary for session continuity

Pass agentName to include your last diary entries — this lets you pick up where you left off.
Use preset='tiny' for a minimal (~180 token) boot, 'standard' (~900, default), or 'full' (~2000).`,
    {
      collection: z
        .string()
        .optional()
        .describe('Focus on a specific collection (e.g. "memories", "crm", "projects")'),
      preset: z
        .enum(['tiny', 'standard', 'full'])
        .optional()
        .describe('Startup size preset (overrides tokenBudget when set): tiny ≈180 tokens (L0 identity + a sliver of L1) for a minimal mempalace-style boot; standard ≈900 (default); full ≈2000.'),
      tokenBudget: z
        .number()
        .optional()
        .default(900)
        .describe('Max tokens for L0+L1 combined (default 900). Ignored when preset is set.'),
      includeL2: z
        .boolean()
        .optional()
        .default(false)
        .describe('Also include L2 filtered layer for the specified collection'),
      category: z
        .string()
        .optional()
        .describe('Category filter for L2 (only used when includeL2=true)'),
      agentName: z
        .string()
        .optional()
        .describe('Your agent name to load recent diary entries for session continuity (e.g. "Claude Code")'),
    },
    wrapToolHandler('memory_wakeup', async (params) => {
      const collection = params.collection as string | undefined;
      const preset = params.preset as 'tiny' | 'standard' | 'full' | undefined;
      // A preset gives a one-word startup-size knob; `tiny` lands cortexmd a
      // sub-200-token boot floor (parity with mempalace's ~170) without changing
      // the default budget for existing callers.
      const PRESET_BUDGET = { tiny: 180, standard: 900, full: 2000 } as const;
      const tokenBudget = preset
        ? PRESET_BUDGET[preset]
        : ((params.tokenBudget as number | undefined) ?? 900);
      const includeL2 = (params.includeL2 as boolean | undefined) ?? false;
      const category = params.category as string | undefined;
      const agentName = params.agentName as string | undefined;

      const layers: MemoryLayer[] = [];

      // Get L0 + L1
      const wakeUpLayers = await wakeUp(collection);
      let totalTokens = 0;

      for (const layer of wakeUpLayers) {
        if (totalTokens + layer.tokens <= tokenBudget) {
          layers.push(layer);
          totalTokens += layer.tokens;
        } else {
          // Truncate this layer to fit budget
          const remainingTokens = Math.max(0, tokenBudget - totalTokens);
          if (remainingTokens > 20) {
            const maxChars = remainingTokens * 4;
            const truncated: MemoryLayer = {
              ...layer,
              content: layer.content.slice(0, maxChars) + '\n... [truncated to fit token budget]',
              tokens: remainingTokens,
            };
            layers.push(truncated);
            totalTokens += remainingTokens;
          }
          break;
        }
      }

      // Optionally include L2
      if (includeL2 && collection) {
        const l2 = await filteredRecall(collection, category);
        layers.push(l2);
        totalTokens += l2.tokens;
      }

      // Agent diary recap
      let diaryRecap: string | null = null;
      if (agentName) {
        try {
          const { entries, total } = await readAgentDiary(agentName.trim(), 5);
          if (entries.length > 0) {
            const lines = [`### Agent Diary: ${agentName} (${total} total entries, showing last ${entries.length})`];
            for (const e of entries) {
              lines.push(`- **${e.date} ${e.time}** — ${e.text}`);
            }
            diaryRecap = lines.join('\n');
            const diaryTokens = Math.ceil(diaryRecap.length / 4);
            layers.push({
              level: 1,
              tokens: diaryTokens,
              content: diaryRecap,
              source: 'agent-diary',
            });
            totalTokens += diaryTokens;
          }
        } catch {
          // diary is optional — no-op on failure
        }
      }

      // List all known agents for awareness
      let knownAgents: string[] = [];
      try {
        const agents = await listAgents();
        knownAgents = agents.map(a => a.name);
      } catch {
        // optional
      }

      const collections = getCollectionNames();

      // Build human-readable output
      const parts: string[] = [];
      for (const layer of layers) {
        const label = layer.source === 'identity.txt' ? 'Identity (L0)'
          : layer.source === 'top-memories' ? 'Essential Narrative (L1)'
          : layer.source === 'filtered' ? 'Filtered Recall (L2)'
          : layer.source === 'agent-diary' ? 'Agent Diary'
          : `Layer ${layer.level}`;
        parts.push(`## ${label}\n*Source: ${layer.source} | ~${layer.tokens} tokens*\n\n${layer.content}`);
      }

      const summary = parts.join('\n\n---\n\n');
      const detailStr = `wakeup${collection ? ' col=' + collection : ''}${agentName ? ' agent=' + agentName : ''} -> ${layers.length} layers, ~${totalTokens} tokens`;

      return {
        _detail: detailStr,
        content: [
          {
            type: 'text',
            text: `${summary}\n\n---\n\n${JSON.stringify({ layers, totalTokens, collections, knownAgents }, null, 2)}`,
          },
        ],
      };
    }),
  );
}
