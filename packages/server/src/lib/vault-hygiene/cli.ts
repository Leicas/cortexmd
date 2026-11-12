/**
 * vault-hygiene CLI (entry: scripts/vault-hygiene.mjs).
 *
 *   vault-hygiene <command…|all> --vault <dir> [--prefix <p>]… [--exclude <p>]… [--json <file|->]
 *                 [--archive-dir Archive/vault-hygiene] [--sample N]
 *                 [--apply --backup-dir <dir>]
 *   vault-hygiene restore --backup <run-dir> [--vault <dir>]
 *
 * DRY-RUN is the default and only mode unless BOTH --apply and --backup-dir
 * are given. Apply backs up every file it will touch (manifest.json + copies)
 * before writing, and moves removed notes into the archive folder.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { HYGIENE_COMMANDS, type HygieneCommand } from './commands.js';
import { planHygiene, formatReport } from './report.js';
import { applyPlan, loadVaultDir, restoreBackup } from './fs-runner.js';
import { DEFAULT_MACHINE_SOURCE_PATTERNS } from './patterns.js';

interface Args {
  positional: string[];
  vault?: string;
  prefixes: string[];
  exclude: string[];
  json?: string;
  apply: boolean;
  backupDir?: string;
  backup?: string;
  archiveDir: string;
  sample: number;
  machineSources?: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = { positional: [], prefixes: [], exclude: [], apply: false, archiveDir: 'Archive/vault-hygiene', sample: 10 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    switch (k) {
      case '--vault': a.vault = next(); break;
      case '--prefix': a.prefixes.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--exclude': a.exclude.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--json': a.json = next(); break;
      case '--apply': a.apply = true; break;
      case '--backup-dir': a.backupDir = next(); break;
      case '--backup': a.backup = next(); break;
      case '--archive-dir': a.archiveDir = next(); break;
      case '--sample': a.sample = parseInt(next(), 10) || 0; break;
      case '--machine-sources': a.machineSources = next().split('|||').filter(Boolean); break;
      case '-h': case '--help': a.positional.unshift('help'); break;
      default:
        if (k.startsWith('--')) throw new Error(`unknown flag ${k}`);
        a.positional.push(k);
    }
  }
  return a;
}

const USAGE = `usage:
  vault-hygiene <${HYGIENE_COMMANDS.join('|')}|all>… --vault <dir> [--prefix <path-prefix>]… [--exclude <path-prefix>]… [--json <file|->]
                [--archive-dir Archive/vault-hygiene] [--sample N] [--apply --backup-dir <dir>]
  vault-hygiene restore --backup <run-dir> [--vault <dir>]
Dry-run unless BOTH --apply and --backup-dir are passed.`;

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try { args = parseArgs(argv); } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (args.positional.length === 0 || args.positional[0] === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return args.positional[0] === 'help' ? 0 : 2;
  }

  if (args.positional[0] === 'restore') {
    if (!args.backup) { process.stderr.write('restore needs --backup <run-dir>\n'); return 2; }
    const r = await restoreBackup(path.resolve(args.backup), args.vault ? path.resolve(args.vault) : undefined);
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return r.mismatched.length === 0 ? 0 : 1;
  }

  const commands = args.positional as Array<HygieneCommand | 'all'>;
  const bad = commands.filter((c) => c !== 'all' && !(HYGIENE_COMMANDS as readonly string[]).includes(c));
  if (bad.length > 0) { process.stderr.write(`unknown command(s): ${bad.join(', ')}\n${USAGE}\n`); return 2; }
  if (!args.vault) { process.stderr.write(`--vault <dir> is required\n${USAGE}\n`); return 2; }
  if (args.apply && !args.backupDir) {
    process.stderr.write('--apply requires --backup-dir <dir>; refusing (dry-run only without a backup).\n');
    return 2;
  }
  const doApply = args.apply && !!args.backupDir;
  const vaultRoot = path.resolve(args.vault);

  const { files, otherFiles } = await loadVaultDir(vaultRoot);
  const run = planHygiene(files, otherFiles, commands, {
    prefixes: args.prefixes,
    excludePrefixes: args.exclude,
    archiveRoot: args.archiveDir,
    machineSourcePatterns: args.machineSources ?? DEFAULT_MACHINE_SOURCE_PATTERNS,
    dryRun: !doApply,
  });

  process.stdout.write(`${formatReport(run.report, args.sample)}\n`);
  if (args.json) {
    const text = JSON.stringify(run.report, null, 2);
    if (args.json === '-') process.stdout.write(`${text}\n`);
    else await fs.writeFile(args.json, text);
  }
  if (!doApply) {
    process.stdout.write('\nDRY-RUN: no file was written. Re-run with --apply --backup-dir <dir> to apply.\n');
    return 0;
  }
  const { runDir, manifest } = await applyPlan(vaultRoot, run.plan, path.resolve(args.backupDir!), run.report.commands);
  process.stdout.write(`\nAPPLIED ${manifest.entries.length} file changes. Backup + manifest: ${runDir}\n` +
    `Undo with: vault-hygiene restore --backup "${runDir}"\n`);
  return 0;
}
