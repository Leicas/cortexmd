import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { wrapToolHandler } from '../lib/tool-wrapper.js';
import { listFiles, readNote } from '../lib/vault.js';
import { config } from '../config.js';
import { HYGIENE_COMMANDS, type HygieneCommand } from '../lib/vault-hygiene/commands.js';
import { planHygiene, formatReport } from '../lib/vault-hygiene/report.js';

/**
 * vault_hygiene — DRY-RUN ONLY over MCP. Reports exactly what each hygiene
 * sub-command would change in the brain vault; it never writes. Applying a
 * plan is deliberately CLI-only (scripts/vault-hygiene.mjs --apply
 * --backup-dir …), where every touched file is backed up with a manifest first.
 */
export function register(server: McpServer): void {
  server.tool(
    'vault_hygiene',
    `Dry-run vault maintenance report (never writes). Sub-commands: ${HYGIENE_COMMANDS.join(', ')} (or "all").
broken-links: unresolvable [[links]] → plain text (+ creates missing diary-linked Projects/Machines stubs). hook-echoes: shell/tool-result/commit/prompt echo captures → archive. junk-projects: auto-reconciled Projects/ notes no diary vouches for → merge/archive. tags: msg:<id>→gmail_id, Gmail labels→email_label, drop source:* duplicates, unspace "k: v". digests: Memories/consolidated → type digest, low, cold, source links → consolidated_from. auto-related: strip ## Related (auto) links to digests/emails. reheat: heat/temperature contradicting category+importance.
Returns counts per command and a sample of planned changes. To APPLY, the owner runs the CLI with --apply --backup-dir.`,
    {
      commands: z
        .array(z.enum([...HYGIENE_COMMANDS, 'all'] as [string, ...string[]]))
        .optional()
        .default(['all'])
        .describe('Sub-commands to plan (default: all)'),
      prefix: z.array(z.string()).optional().describe('Only consider notes under these path prefixes'),
      exclude: z.array(z.string()).optional().describe('Skip notes under these path prefixes'),
      sample: z.number().int().min(0).max(200).optional().default(10).describe('Changes listed per command'),
    },
    wrapToolHandler('vault_hygiene', async (params) => {
      const commands = ((params.commands as string[] | undefined) ?? ['all']) as Array<HygieneCommand | 'all'>;
      const sample = (params.sample as number | undefined) ?? 10;
      const all = await listFiles('.', '**/*');
      const files: Array<[string, string]> = [];
      const other: string[] = [];
      for (const p of all) {
        if (!/\.md$/i.test(p)) { other.push(p); continue; }
        try { files.push([p, (await readNote(p)).content]); } catch { /* unreadable — skipped */ }
      }
      const run = planHygiene(files, other, commands, {
        prefixes: params.prefix as string[] | undefined,
        excludePrefixes: params.exclude as string[] | undefined,
        machineSourcePatterns: config.machineCaptureSourcePatterns,
        dryRun: true,
      });
      const { log, changes, ...summary } = run.report;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...summary,
              sample: Object.fromEntries(
                Object.keys(summary.perCommand).map((c) => [c, log.filter((r) => r.command === c).slice(0, sample)]),
              ),
              apply: 'CLI only: node scripts/vault-hygiene.mjs <commands> --vault <brain-vault> --apply --backup-dir <dir>',
            }),
          },
          { type: 'text' as const, text: formatReport(run.report, 0) },
        ],
      };
    }),
  );
}
