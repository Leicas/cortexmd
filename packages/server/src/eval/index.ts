/**
 * ============================================================================
 * Temporal recall-quality EVAL HARNESS
 * ============================================================================
 *
 * WHAT THIS IS
 *   A measurement rig for cortexmd's memory recall. It ingests a *timeline* of
 *   memory events into an isolated temp vault, then asks point-in-time recall
 *   queries and scores three things:
 *     - recallAtK            — did recall surface the facts it should?
 *     - pointInTimeAccuracy  — for temporal queries, did it surface the fact
 *                              VALID AT the query's timestamp (and not a later,
 *                              superseding one)?
 *     - staleLeakRate        — how often did a superseded/stale fact leak into
 *                              the top-k?
 *
 * WHY THE TEMPORAL NUMBERS WILL LOOK BAD (ON PURPOSE)
 *   Current cortexmd has NO bitemporal fact-validity model. Recall fuses
 *   lexical + semantic similarity with heat/recency/validity boosts, but it
 *   does NOT reason about "what was true as of date X". So a query asked "as
 *   of" an early timestamp will happily surface a fact that only became true
 *   later — pointInTimeAccuracy will be low and staleLeakRate high.
 *
 *   THAT POOR NUMBER IS THE BASELINE. The planned bitemporal-KG work must
 *   MOVE it. This harness exists so that improvement is measured, not guessed.
 *   recallAtK, by contrast, should already be decent — it's the non-temporal
 *   control.
 *
 * SCENARIO SCHEMA (the dataset agent depends on these exact field names)
 *   Scenario = {
 *     id: string,
 *     description: string,
 *     events:  Array<{ ts: string /*ISO*\/, content: string, tags?: string[] }>,
 *     queries: Array<{
 *       ts: string /*point-in-time ISO*\/,
 *       query: string,
 *       expectContains: string[],   // substrings a correct recall MUST surface
 *       expectAbsent?: string[],    // superseded/stale facts that must NOT surface
 *       hops?: 1 | 2,
 *     }>,
 *   }
 *   Dataset = JSONL, one Scenario per line.
 *
 * USAGE (tsx is a devDep, so this runs straight from source — no build step)
 *   npx tsx src/eval/index.ts --smoke               # tiny bundled fixtures
 *   npx tsx src/eval/index.ts --dataset path.jsonl --k 5
 *   npm run eval -- --smoke                          # same, via the npm script
 *   EVAL_EMBEDDINGS=1 npx tsx src/eval/index.ts --smoke  # + real embedding index
 *
 *   BITEMPORAL A/B (the whole point of the feature work):
 *     npx tsx src/eval/index.ts --smoke --bitemporal  # treatment arm only
 *                                                     #   (flag ON + asOf filtering)
 *     npx tsx src/eval/index.ts --smoke --compare     # run BOTH arms, print a
 *                                                     #   baseline-vs-bitemporal delta
 *
 *   NOTE: `npm run eval -- --flag` drops the flags on some platforms (the
 *   Windows npm cmd shim). Env fallbacks cover that case:
 *     EVAL_SMOKE=1 npm run eval
 *     EVAL_DATASET=path.jsonl EVAL_K=10 npm run eval
 *     EVAL_SMOKE=1 EVAL_BITEMPORAL=1 npm run eval     # treatment arm
 *     EVAL_SMOKE=1 EVAL_COMPARE=1 npm run eval        # A/B compare
 *
 * The default retriever drives the REAL pipeline over a mkdtemp vault and
 * cleans it up afterward; nothing touches your real brain vault.
 * ============================================================================
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHarness, loadDataset } from './runner.js';
import type { EvalReport } from './types.js';

export * from './types.js';
export * from './scoring.js';
export { runHarness, loadDataset, loadDatasetFile, createRealRetriever } from './runner.js';
export type { RunHarnessOptions, LifecycleRetriever } from './runner.js';

interface CliArgs {
  dataset?: string;
  k: number;
  smoke: boolean;
  /** Run with the BITEMPORAL_KG feature ON (as-of recall + supersession). */
  bitemporal: boolean;
  /**
   * Run BOTH arms — baseline (flag OFF, no asOf) and bitemporal (flag ON,
   * asOf=query ts) — over the same dataset and print the two reports plus a
   * delta table. Overrides `bitemporal`.
   */
  compare: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  // Env fallbacks first — npm on some platforms (notably the Windows cmd shim)
  // drops `-- --flag` args before they reach the script, so `EVAL_SMOKE=1
  // npm run eval` / `EVAL_DATASET=... npm run eval` stay usable there. Explicit
  // CLI flags below override these.
  const args: CliArgs = {
    k: parseInt(process.env.EVAL_K ?? '', 10) || 5,
    smoke: process.env.EVAL_SMOKE === '1' || process.env.EVAL_SMOKE === 'true',
    dataset: process.env.EVAL_DATASET || undefined,
    bitemporal: process.env.EVAL_BITEMPORAL === '1' || process.env.EVAL_BITEMPORAL === 'true',
    compare: process.env.EVAL_COMPARE === '1' || process.env.EVAL_COMPARE === 'true',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') args.smoke = true;
    else if (a === '--bitemporal') args.bitemporal = true;
    else if (a === '--compare') args.compare = true;
    else if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--k') args.k = parseInt(argv[++i], 10) || 5;
    else if (a.startsWith('--k=')) args.k = parseInt(a.slice('--k='.length), 10) || 5;
    else if (a.startsWith('--dataset=')) args.dataset = a.slice('--dataset='.length);
  }
  return args;
}

/** Resolve the bundled smoke fixture path relative to this module. */
function smokeFixturePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'fixtures', 'scenarios.sample.jsonl');
}

/** Render a compact human-readable table alongside the JSON report. */
function humanTable(report: EvalReport, arm?: string): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('');
  const armSuffix = arm ? `  [${arm}]` : '';
  lines.push(`Temporal recall eval  (k=${report.k}, scenarios=${report.nScenarios}, queries=${report.nQueries})${armSuffix}`);
  lines.push('─'.repeat(64));
  lines.push(`  recall@k             ${pct(report.recallAtK)}`);
  const pitNote = arm === 'bitemporal' ? '(as-of filtering ON)' : '(baseline — no bitemporal model yet)';
  lines.push(`  pointInTimeAccuracy  ${pct(report.pointInTimeAccuracy)}   ${pitNote}`);
  lines.push(`  staleLeakRate        ${pct(report.staleLeakRate)}   (lower is better)`);
  lines.push('─'.repeat(64));
  const idW = Math.max(8, ...report.perScenario.map((s) => s.id.length));
  lines.push(`  ${'scenario'.padEnd(idW)}  q   rec@k   pitAcc  stale`);
  for (const s of report.perScenario) {
    lines.push(
      `  ${s.id.padEnd(idW)}  ${String(s.nQueries).padStart(1)}   ` +
        `${pct(s.recallAtK).padStart(6)}  ${pct(s.pointInTimeAccuracy).padStart(6)}  ${pct(s.staleLeakRate).padStart(5)}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Side-by-side A/B delta table for `--compare`. Shows each headline metric for
 * the baseline arm (flag OFF, no asOf) next to the bitemporal arm (flag ON,
 * asOf=query ts) and the signed delta. recall@k should hold; pointInTimeAccuracy
 * should rise; staleLeakRate should fall.
 */
function compareTable(baseline: EvalReport, bitemporal: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const delta = (b: number, t: number) => {
    const d = (t - b) * 100;
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(1)}pt`;
  };
  const row = (name: string, b: number, t: number, better: 'up' | 'down') => {
    const d = (t - b) * 100;
    const good = better === 'up' ? d > 0.05 : d < -0.05;
    const flat = Math.abs(d) <= 0.05;
    const mark = flat ? '·' : good ? '✓' : '✗';
    return `  ${name.padEnd(20)} ${pct(b).padStart(7)}  →  ${pct(t).padStart(7)}   ${delta(b, t).padStart(9)}  ${mark}`;
  };
  const lines: string[] = [];
  lines.push('');
  lines.push(`A/B compare  (k=${baseline.k}, scenarios=${baseline.nScenarios}, queries=${baseline.nQueries})`);
  lines.push('─'.repeat(64));
  lines.push(`  ${'metric'.padEnd(20)} ${'baseline'.padStart(7)}     ${'bitemporal'.padStart(7)}   ${'delta'.padStart(9)}`);
  lines.push('─'.repeat(64));
  lines.push(row('recall@k', baseline.recallAtK, bitemporal.recallAtK, 'up'));
  lines.push(row('pointInTimeAccuracy', baseline.pointInTimeAccuracy, bitemporal.pointInTimeAccuracy, 'up'));
  lines.push(row('staleLeakRate', baseline.staleLeakRate, bitemporal.staleLeakRate, 'down'));
  lines.push('─'.repeat(64));
  lines.push('  ✓ = moved the right way, ✗ = wrong way, · = flat (recall@k should stay ~flat)');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = args.smoke ? smokeFixturePath() : args.dataset;
  if (!datasetPath) {
    process.stderr.write(
      'Usage: eval --dataset <path.jsonl> [--k N] [--bitemporal | --compare] | eval --smoke\n',
    );
    process.exit(2);
    return;
  }

  const dataset = await loadDataset(datasetPath);

  if (args.compare) {
    // Run both arms over the SAME dataset, each in its OWN child process. A
    // single process cannot host both arms: config.ts / vault / search / the KG
    // module read env (vault path, data dir, BITEMPORAL_KG flag) at module-load
    // and cache it for the process lifetime, so a second in-process run would
    // reuse the first arm's frozen config (and its already-cleaned temp vault).
    // Separate processes give each arm a clean module graph + isolated vault.
    const baseline = await runArmSubprocess('baseline', datasetPath, args.k);
    const bitemporal = await runArmSubprocess('bitemporal', datasetPath, args.k);

    process.stdout.write(
      JSON.stringify({ baseline, bitemporal }, null, 2) + '\n',
    );
    process.stdout.write(humanTable(baseline, 'baseline') + '\n');
    process.stdout.write(humanTable(bitemporal, 'bitemporal') + '\n');
    process.stdout.write(compareTable(baseline, bitemporal) + '\n');
    return;
  }

  // Single-arm run: default retriever = REAL cortexmd pipeline over an isolated
  // temp vault. `--bitemporal` flips the feature on for this run.
  const report = await runHarness(dataset, { k: args.k, bitemporal: args.bitemporal });

  // `--compare` spawns this entrypoint per arm and needs to parse the report
  // back out of stdout. In that internal mode emit ONLY a single fenced JSON
  // line so the parent can find it unambiguously amid the pipeline's log noise.
  if (process.env.EVAL_REPORT_JSON === '1') {
    process.stdout.write(REPORT_MARKER + JSON.stringify(report) + '\n');
    return;
  }

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(humanTable(report, args.bitemporal ? 'bitemporal' : 'baseline') + '\n');
}

/** Sentinel prefixing the one machine-readable report line in EVAL_REPORT_JSON mode. */
const REPORT_MARKER = '@@EVAL_REPORT@@ ';

/**
 * Run ONE arm in a clean child process and return its report. Isolation is
 * mandatory: config.ts / vault / search / the KG module resolve env (vault
 * path, data dir, the BITEMPORAL_KG flag) at module-load and cache it for the
 * life of the process, so two arms cannot share one process. The child prints a
 * single `@@EVAL_REPORT@@ {json}` line (EVAL_REPORT_JSON=1); we parse that.
 */
async function runArmSubprocess(
  arm: 'baseline' | 'bitemporal',
  datasetPath: string,
  k: number,
): Promise<EvalReport> {
  const { spawn } = await import('node:child_process');
  const selfPath = fileURLToPath(import.meta.url);
  const argv = [selfPath, '--dataset', datasetPath, '--k', String(k)];
  if (arm === 'bitemporal') argv.push('--bitemporal');

  // Inherit the parent's Node exec args (crucially, the tsx loader `--require`
  // / `--import` when the parent was launched via tsx) so the child can load
  // this .ts entrypoint the same way. Strip any `--eval`/`-e` + its script
  // argument, which must never be forwarded to a file run.
  const execArgv: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const a = process.execArgv[i];
    if (a === '--eval' || a === '-e' || a === '--print' || a === '-p') {
      i++; // skip the inline script that follows
      continue;
    }
    execArgv.push(a);
  }

  return await new Promise<EvalReport>((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, ...argv], {
      env: {
        ...process.env,
        EVAL_REPORT_JSON: '1',
        // Don't let the parent's mode env leak into the child and re-trigger
        // compare / cross-contaminate the arm selection.
        EVAL_COMPARE: '',
        EVAL_BITEMPORAL: '',
        EVAL_SMOKE: '',
        EVAL_DATASET: '',
        EVAL_K: '',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${arm} arm exited with code ${code}`));
        return;
      }
      const line = out.split('\n').find((l) => l.startsWith(REPORT_MARKER));
      if (!line) {
        reject(new Error(`${arm} arm produced no report line`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice(REPORT_MARKER.length)) as EvalReport);
      } catch (err) {
        reject(new Error(`${arm} arm report parse failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  });
}

// Run as a script (node dist/eval/index.js or tsx src/eval/index.ts), not on import.
const invokedDirectly = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write((err instanceof Error ? err.stack ?? err.message : String(err)) + '\n');
    process.exit(1);
  });
}
