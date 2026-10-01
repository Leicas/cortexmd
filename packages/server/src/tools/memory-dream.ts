import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { runDreamCycle } from '../lib/dream-engine.js';
import { appendJournalEntry } from '../lib/journal.js';

export function register(server: McpServer): void {
  server.tool(
    'memory_dream',
    `Analyze memory activity, themes, orphan notes, connections, and consolidation opportunities. Optionally apply decay, archival, and source-preserving consolidation. Vault hygiene (on by default): orphan triage (delete empty, archive noise, link valuable) and project-note reconstruction; results in report.hygiene. Dry-run reports consolidation candidates without writes or LLM requests; decay/archive counts are only known when applied.`,
    {
      daysBack: z.number().min(1).max(90).optional().describe('How many days of activity to analyze (default: 7)'),
      autoDecay: z.boolean().optional().describe('Run temperature decay on stale memories (default: true)'),
      autoArchive: z.boolean().optional().describe('Auto-archive cold memories untouched for 90+ days (default: true)'),
      autoConsolidate: z.boolean().optional().describe('Auto-apply eligible consolidation groups (≥5 notes AND ≥3 shared tags), preserving original sources. Default: false'),
      dryRun: z.boolean().optional().describe('If true, return consolidation candidates without applying changes or calling the LLM. Decay/archive counts are not predicted. Default: false'),
      runLlm: z.boolean().optional().describe('Run LLM synthesis pass. Default: auto (true when reranker configured)'),
      maxThemes: z.number().min(1).max(20).optional().describe('Maximum themes to detect (default: 5)'),
      maxOrphans: z.number().min(1).max(50).optional().describe('Maximum orphan memories to report (default: 20)'),
      maxConnections: z.number().min(1).max(30).optional().describe('Maximum connection suggestions (default: 10)'),
      maxConsolidations: z.number().min(1).max(20).optional().describe('Maximum consolidation groups (default: 5)'),
      reconcileProjects: z.boolean().optional().describe('Link clusters of related cold notes into Projects/ notes by shared entity/tag overlap, preserving the originals. Default: true'),
      reconcileColdOnly: z.boolean().optional().describe('Restrict project reconciliation to cold notes; set false to also pull in warm notes. Default: true'),
      reconcileMinClusterSize: z.number().min(2).max(20).optional().describe('Minimum notes in a cluster before a project is created/updated (default: 2)'),
      orphanTriage: z.boolean().optional().describe('Triage notes with zero inbound links: delete EMPTY ones (frontmatter/headings only), archive capture NOISE, link VALUABLE ones from their project hub or a monthly type index. Honors dryRun. Default: DREAM_ORPHAN_TRIAGE (on)'),
      triageDeleteEmpty: z.boolean().optional().describe('Orphan triage: delete empty orphans (default: DREAM_TRIAGE_DELETE_EMPTY, on)'),
      triageArchiveNoise: z.boolean().optional().describe('Orphan triage: archive capture-noise orphans (default: DREAM_TRIAGE_ARCHIVE_NOISE, on)'),
      triageLink: z.boolean().optional().describe('Orphan triage: link valuable orphans (default: DREAM_TRIAGE_LINK, on)'),
      triageMinAgeDays: z.number().min(0).max(3650).optional().describe('Orphan triage: only touch notes at least this old (default: DREAM_TRIAGE_MIN_AGE_DAYS, 7)'),
      projectRebuild: z.boolean().optional().describe('Rebuild Projects/<slug>.md managed "Related memories" sections (grouped, capped, dangling links dropped; user text preserved). Default: DREAM_PROJECT_REBUILD (on)'),
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
        reconcileProjects: params.reconcileProjects as boolean | undefined,
        reconcileColdOnly: params.reconcileColdOnly as boolean | undefined,
        reconcileMinClusterSize: params.reconcileMinClusterSize as number | undefined,
        orphanTriage: params.orphanTriage as boolean | undefined,
        projectRebuild: params.projectRebuild as boolean | undefined,
        triage: Object.fromEntries(Object.entries({
          deleteEmpty: params.triageDeleteEmpty as boolean | undefined,
          archiveNoise: params.triageArchiveNoise as boolean | undefined,
          link: params.triageLink as boolean | undefined,
          minAgeDays: params.triageMinAgeDays as number | undefined,
        }).filter(([, v]) => v !== undefined)),
      });

      // Log the dream cycle to the journal (skip in dryRun)
      if (!report.dryRun) {
        const autoApplied = report.consolidationGroups.filter((g) => g.autoApplied).length;
        await appendJournalEntry(
          `Dream cycle completed: ${report.themes.length} themes, ${report.orphans.length} orphans, ` +
          `${report.connectionSuggestions.length} connection suggestions, ` +
          `${report.consolidationGroups.length} consolidation groups (${autoApplied} auto-applied). ` +
          `Decayed: ${report.lifecycle.decayed}, Archived: ${report.lifecycle.archived.length}. ` +
          `Hygiene: deleted_empty ${report.hygiene.deleted_empty}, archived_noise ${report.hygiene.archived_noise}, ` +
          `linked ${report.hygiene.linked}, projects_rebuilt ${report.hygiene.projects_rebuilt}, skipped ${report.hygiene.skipped}` +
          `${report.hygiene.skipReason ? ` (${report.hygiene.skipReason})` : ''}. ` +
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
