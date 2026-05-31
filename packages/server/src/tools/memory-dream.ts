import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { runDreamCycle } from '../lib/dream-engine.js';
import { appendJournalEntry } from '../lib/journal.js';

export function register(server: McpServer): void {
  server.tool(
    'memory_dream',
    `Run a dream cycle — the vault's memory consolidation and maintenance process. This analyzes recent memory activity, detects recurring themes, finds orphan memories needing links, suggests connections between related notes, identifies consolidation opportunities, and optionally runs temperature decay, auto-archival, and auto-consolidation of high-confidence groups. Always includes an 'llm' block in the response (ran + skipReason + summary + model). Use dryRun=true to preview what would be archived/consolidated without touching the vault.`,
    {
      daysBack: z.number().min(1).max(90).optional().describe('How many days of activity to analyze (default: 7)'),
      autoDecay: z.boolean().optional().describe('Run temperature decay on stale memories (default: true)'),
      autoArchive: z.boolean().optional().describe('Auto-archive cold memories untouched for 90+ days (default: true)'),
      autoConsolidate: z.boolean().optional().describe('Auto-apply high-confidence consolidation groups (≥5 notes AND ≥3 shared tags). Lower-confidence groups still surface as suggestions. Default: true'),
      dryRun: z.boolean().optional().describe('If true, return the would-be archive/consolidation lists without applying. Default: false'),
      runLlm: z.boolean().optional().describe('Run LLM synthesis pass. Default: auto (true when reranker configured)'),
      maxThemes: z.number().min(1).max(20).optional().describe('Maximum themes to detect (default: 5)'),
      maxOrphans: z.number().min(1).max(50).optional().describe('Maximum orphan memories to report (default: 20)'),
      maxConnections: z.number().min(1).max(30).optional().describe('Maximum connection suggestions (default: 10)'),
      maxConsolidations: z.number().min(1).max(20).optional().describe('Maximum consolidation groups (default: 5)'),
    },
    wrapToolHandler('memory_dream', async (params) => {
      const report = await runDreamCycle({
        daysBack: params.daysBack as number | undefined,
        autoDecay: params.autoDecay as boolean | undefined,
        autoArchive: params.autoArchive as boolean | undefined,
        autoConsolidate: params.autoConsolidate as boolean | undefined,
        dryRun: params.dryRun as boolean | undefined,
        runLlm: params.runLlm as boolean | undefined,
        maxThemes: params.maxThemes as number | undefined,
        maxOrphans: params.maxOrphans as number | undefined,
        maxConnections: params.maxConnections as number | undefined,
        maxConsolidations: params.maxConsolidations as number | undefined,
      });

      // Log the dream cycle to the journal (skip in dryRun)
      if (!report.dryRun) {
        const autoApplied = report.consolidationGroups.filter((g) => g.autoApplied).length;
        await appendJournalEntry(
          `Dream cycle completed: ${report.themes.length} themes, ${report.orphans.length} orphans, ` +
          `${report.connectionSuggestions.length} connection suggestions, ` +
          `${report.consolidationGroups.length} consolidation groups (${autoApplied} auto-applied). ` +
          `Decayed: ${report.lifecycle.decayed}, Archived: ${report.lifecycle.archived.length}. ` +
          `LLM: ${report.llm.ran ? 'ran' : `skipped (${report.llm.skipReason ?? 'unknown'})`}`
        );
      }

      return {
        content: [{
          type: 'text',
          text: `${report.narrative}\n\n${JSON.stringify(report, null, 2)}`,
        }],
      };
    })
  );
}
