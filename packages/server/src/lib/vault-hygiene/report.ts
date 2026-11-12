/**
 * Plan + report for a hygiene run (pure). Shared by the CLI and the dry-run
 * MCP tool.
 */
import { computePlan, VaultModel, type PlannedChange } from './model.js';
import { runHygiene, type HygieneCommand, type HygieneOptions } from './commands.js';

export interface HygieneReport {
  dryRun: boolean;
  commands: string[];
  scanned: number;
  parseErrors: number;
  totals: { modify: number; archive: number; create: number; files: number };
  perCommand: Record<string, { notes: number; actions: Record<string, number> }>;
  /** Every planned file change (no content). */
  changes: Array<Omit<PlannedChange, 'newContent'>>;
  /** Per-note action log: what each command did and why. */
  log: VaultModel['log'];
}

export interface HygieneRun {
  model: VaultModel;
  plan: PlannedChange[];
  report: HygieneReport;
}

export function planHygiene(
  files: Iterable<[string, string]>,
  otherFiles: Iterable<string>,
  commands: Array<HygieneCommand | 'all'>,
  opts: HygieneOptions & { archiveRoot?: string; dryRun?: boolean } = {},
): HygieneRun {
  const model = new VaultModel(files, otherFiles, opts.archiveRoot);
  const scanned = model.notes.size;
  const parseErrors = [...model.notes.values()].filter((n) => n.parseError).length;
  runHygiene(model, commands, opts);
  const plan = computePlan(model);

  const perCommand: HygieneReport['perCommand'] = {};
  const notesBy = new Map<string, Set<string>>();
  for (const r of model.log) {
    const entry = perCommand[r.command] ?? (perCommand[r.command] = { notes: 0, actions: {} });
    entry.actions[r.action] = (entry.actions[r.action] ?? 0) + 1;
    const set = notesBy.get(r.command) ?? new Set<string>();
    set.add(r.path);
    notesBy.set(r.command, set);
  }
  for (const [c, set] of notesBy) perCommand[c].notes = set.size;

  const report: HygieneReport = {
    dryRun: opts.dryRun !== false,
    commands: commands.map(String),
    scanned,
    parseErrors,
    totals: {
      modify: plan.filter((p) => p.op === 'modify').length,
      archive: plan.filter((p) => p.op === 'archive').length,
      create: plan.filter((p) => p.op === 'create').length,
      files: plan.length,
    },
    perCommand,
    changes: plan.map(({ newContent: _c, ...rest }) => rest),
    log: model.log,
  };
  return { model, plan, report };
}

/** Human-readable summary (counts + the first `sample` changes per command). */
export function formatReport(report: HygieneReport, sample = 10): string {
  const lines: string[] = [];
  lines.push(`vault-hygiene ${report.dryRun ? 'DRY-RUN (nothing written)' : 'APPLY'} — commands: ${report.commands.join(', ')}`);
  lines.push(`scanned ${report.scanned} notes (${report.parseErrors} with unparseable frontmatter, skipped for property edits)`);
  lines.push(`planned: ${report.totals.files} files — ${report.totals.modify} modified, ${report.totals.archive} moved to archive, ${report.totals.create} created`);
  for (const [cmd, s] of Object.entries(report.perCommand)) {
    const acts = Object.entries(s.actions).map(([a, n]) => `${a}=${n}`).join(', ');
    lines.push(`  ${cmd}: ${s.notes} notes (${acts})`);
    const sampleLog = report.log.filter((r) => r.command === cmd).slice(0, sample);
    for (const r of sampleLog) {
      const detail = r.detail === undefined ? '' : ` ${JSON.stringify(r.detail).slice(0, 160)}`;
      lines.push(`    - ${r.action} ${r.path}${detail}`);
    }
  }
  return lines.join('\n');
}
