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
 *   TREATMENT ARMS (the point of the feature work):
 *     npx tsx src/eval/index.ts --smoke --bitemporal  # bitemporal arm only
 *                                                     #   (flag ON + asOf filtering)
 *     npx tsx src/eval/index.ts --smoke --graph       # PPR graph-recall arm only
 *                                                     #   (graph:true + KG mentions)
 *     npx tsx src/eval/index.ts --smoke --compare     # run ALL arms (baseline /
 *                                                     #   bitemporal / ppr /
 *                                                     #   ppr+bitemp) + delta +
 *                                                     #   per-scenario recall matrix
 *
 *   REAL-VAULT BENCHMARK (retrieval quality + latency over a local snapshot):
 *     node scripts/snapshot-vault.mjs --source local --from <vault> --exclude EmailLog
 *     npx tsx src/eval/index.ts --real-vault .realvault-snapshot --arms lexical,semantic,ppr
 *
 *   NOTE: `npm run eval -- --flag` drops the flags on some platforms (the
 *   Windows npm cmd shim). Env fallbacks cover that case:
 *     EVAL_SMOKE=1 npm run eval
 *     EVAL_DATASET=path.jsonl EVAL_K=10 npm run eval
 *     EVAL_SMOKE=1 EVAL_BITEMPORAL=1 npm run eval     # bitemporal arm
 *     EVAL_SMOKE=1 EVAL_GRAPH=1 npm run eval          # PPR graph arm
 *     EVAL_SMOKE=1 EVAL_COMPARE=1 npm run eval        # all-arm compare
 *     EVAL_REAL_VAULT=.realvault-snapshot EVAL_ARMS=lexical,ppr npm run eval
 *
 * The default retriever drives the REAL pipeline over a mkdtemp vault and
 * cleans it up afterward; nothing touches your real brain vault. The real-vault
 * mode reads (never writes) the snapshot dir you point it at.
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
  /** Run with the PPR graph-recall arm ON (per-call graph:true + KG mentions). */
  graph: boolean;
  /**
   * Run the full arm matrix — baseline, bitemporal, ppr, and ppr+bitemporal —
   * over the same dataset and print each report plus a delta table (baseline is
   * the reference). Overrides `bitemporal` / `graph`.
   */
  compare: boolean;
  /**
   * Real-vault benchmark mode: point at a local snapshot dir and score
   * retrieval quality (recall@k / MRR / latency) with auto-derived gold sets,
   * comparable across lexical / +semantic / +ppr arms. Bypasses the temporal
   * dataset path entirely. Env fallback: EVAL_REAL_VAULT.
   */
  realVault?: string;
  /** Arms for real-vault mode (default lexical,semantic,ppr). */
  arms?: string;
  /**
   * Directory to persist the dashboard eval artifacts into (eval-report.json +
   * eval-history.jsonl). Defaults to `config.dataDir` unless EVAL_OUT / --out
   * overrides it. The Retrieval tab's Recall-Quality panel reads these files.
   */
  out?: string;
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
    graph: process.env.EVAL_GRAPH === '1' || process.env.EVAL_GRAPH === 'true',
    compare: process.env.EVAL_COMPARE === '1' || process.env.EVAL_COMPARE === 'true',
    realVault: process.env.EVAL_REAL_VAULT || undefined,
    arms: process.env.EVAL_ARMS || undefined,
    out: process.env.EVAL_OUT || undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') args.smoke = true;
    else if (a === '--bitemporal') args.bitemporal = true;
    else if (a === '--graph') args.graph = true;
    else if (a === '--compare') args.compare = true;
    else if (a === '--dataset') args.dataset = argv[++i];
    else if (a === '--real-vault') args.realVault = argv[++i];
    else if (a.startsWith('--real-vault=')) args.realVault = a.slice('--real-vault='.length);
    else if (a === '--arms') args.arms = argv[++i];
    else if (a.startsWith('--arms=')) args.arms = a.slice('--arms='.length);
    else if (a === '--out') args.out = argv[++i];
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a === '--k') args.k = parseInt(argv[++i], 10) || 5;
    else if (a.startsWith('--k=')) args.k = parseInt(a.slice('--k='.length), 10) || 5;
    else if (a.startsWith('--dataset=')) args.dataset = a.slice('--dataset='.length);
  }
  return args;
}

/**
 * The dashboard eval artifacts. Kept in lockstep with
 * `dashboard/model/eval-report-reader.ts` (same filenames + arm-row shape).
 */
const EVAL_REPORT_FILE = 'eval-report.json';
const EVAL_HISTORY_FILE = 'eval-history.jsonl';

/** One arm row as persisted to eval-report.json (RetrievalQualityArm shape). */
interface PersistedArm {
  arm: Arm;
  recallAtK: number;
  pointInTimeAccuracy: number;
  staleLeakRate: number;
  mrr: number | null;
  avgLatencyMs: number | null;
}

/**
 * Resolve the output dir the dashboard reads from. Explicit `--out`/EVAL_OUT
 * wins; otherwise fall back to `config.dataDir`. Imported lazily so a plain
 * `--smoke` run without persistence never pulls config (which freezes env).
 */
async function resolveOutDir(explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const { config } = await import('../config.js');
  return config.dataDir;
}

/**
 * Persist the last eval report (arm compare) + append a headline history row.
 * Best-effort: a write failure logs to stderr and does not fail the eval run.
 * `arms` is the full compare set (baseline-first); the history row is the
 * BASELINE arm's headline metrics, so the trend line tracks the untreated
 * pipeline across runs. Non-baseline single-arm runs still write a report but
 * use their own arm's headline for history (best available signal).
 */
async function persistEvalReport(
  outDir: string | undefined,
  mode: 'temporal' | 'real-vault',
  k: number,
  arms: PersistedArm[],
): Promise<void> {
  if (arms.length === 0) return;
  try {
    const fs = await import('node:fs');
    const dir = await resolveOutDir(outDir);
    fs.mkdirSync(dir, { recursive: true });
    const ranAt = Date.now();

    const report = { ranAt, mode, k, arms };
    const reportPath = path.join(dir, EVAL_REPORT_FILE);
    const tmp = reportPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, reportPath);

    // History row: prefer the baseline arm; else the first arm present.
    const head = arms.find((a) => a.arm === 'baseline') ?? arms[0];
    const historyRow = {
      ranAt,
      recallAtK: head.recallAtK,
      pointInTimeAccuracy: head.pointInTimeAccuracy,
      staleLeakRate: head.staleLeakRate,
    };
    fs.appendFileSync(path.join(dir, EVAL_HISTORY_FILE), JSON.stringify(historyRow) + '\n', { mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      `warn: failed to persist eval report: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/** Map an EvalReport (temporal harness) → a persisted arm row. */
function temporalArmRow(arm: Arm, report: EvalReport): PersistedArm {
  return {
    arm,
    recallAtK: report.recallAtK,
    pointInTimeAccuracy: report.pointInTimeAccuracy,
    staleLeakRate: report.staleLeakRate,
    mrr: null,
    avgLatencyMs: null,
  };
}

/**
 * Map a RealVaultReport → persisted arm rows in the RetrievalQualityArm arm
 * space. Real-vault has no temporal labels, so PIT/leak are 0 and MRR/latency
 * carry through. Arm mapping: lexical/semantic are pre-graph pipeline stages →
 * folded to `baseline`; `ppr` → `ppr`. The multi-hop gold set (wikilink
 * neighbours — the PPR-relevant signal) is preferred; self-retrieval is the
 * fallback when multi-hop had no linked notes.
 */
function realVaultArmRows(report: import('./real-vault.js').RealVaultReport): PersistedArm[] {
  const rows = report.multiHop.length > 0 ? report.multiHop : report.selfRetrieval;
  const byArm = new Map<Arm, PersistedArm>();
  for (const r of rows) {
    const arm: Arm = r.arm === 'ppr' ? 'ppr' : 'baseline';
    // If both lexical and semantic map to baseline, keep the stronger recall.
    const existing = byArm.get(arm);
    if (existing && existing.recallAtK >= r.recallAtK) continue;
    byArm.set(arm, {
      arm,
      recallAtK: r.recallAtK,
      pointInTimeAccuracy: 0,
      staleLeakRate: 0,
      mrr: r.mrr,
      avgLatencyMs: r.avgLatencyMs,
    });
  }
  // baseline-first ordering for a stable report.
  const order: Arm[] = ['baseline', 'bitemporal', 'ppr', 'ppr-bitemporal'];
  return order.filter((a) => byArm.has(a)).map((a) => byArm.get(a)!);
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
 * The four A/B arms `--compare` runs. Each maps to a distinct combination of
 * the two independent, composable treatment flags (bitemporal, graph):
 *   baseline        — both OFF (the reference; recall is byte-identical to today)
 *   bitemporal      — BITEMPORAL_KG ON, as-of filtering ON
 *   ppr             — PPR graph-recall arm ON (graph:true + KG mention bridges)
 *   ppr-bitemporal  — both ON
 * baseline is always the delta reference so every treatment is measured against
 * the untreated pipeline.
 */
type Arm = 'baseline' | 'bitemporal' | 'ppr' | 'ppr-bitemporal';

const ARM_LABEL: Record<Arm, string> = {
  baseline: 'baseline',
  bitemporal: 'bitemporal',
  ppr: 'ppr',
  'ppr-bitemporal': 'ppr+bitemp',
};

/** The (bitemporal, graph) flag pair each arm sets. */
function armFlags(arm: Arm): { bitemporal: boolean; graph: boolean } {
  return {
    bitemporal: arm === 'bitemporal' || arm === 'ppr-bitemporal',
    graph: arm === 'ppr' || arm === 'ppr-bitemporal',
  };
}

/**
 * Headline-metric delta table: every treatment arm's three metrics next to the
 * baseline arm, with signed deltas. recall@k should hold or RISE (the PPR arm
 * targets multi-hop recall); pointInTimeAccuracy should rise on the bitemporal
 * arms; staleLeakRate should fall on the bitemporal arms.
 */
function compareTable(baseline: EvalReport, treatments: Array<{ arm: Arm; report: EvalReport }>): string {
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
  for (const { arm, report } of treatments) {
    lines.push('═'.repeat(64));
    lines.push(`  ${ARM_LABEL[arm]}  vs baseline`);
    lines.push('─'.repeat(64));
    lines.push(row('recall@k', baseline.recallAtK, report.recallAtK, 'up'));
    lines.push(row('pointInTimeAccuracy', baseline.pointInTimeAccuracy, report.pointInTimeAccuracy, 'up'));
    lines.push(row('staleLeakRate', baseline.staleLeakRate, report.staleLeakRate, 'down'));
  }
  lines.push('═'.repeat(64));
  lines.push('  ✓ = moved the right way, ✗ = wrong way, · = flat');
  lines.push('');
  return lines.join('\n');
}

/**
 * Per-scenario recall@k matrix across all arms. This is where the multi-hop
 * scenarios (person-to-project, service-owner-oncall) become visible: the PPR
 * arm should lift THOSE rows even when the aggregate barely moves. One column
 * per arm, one row per scenario, values are recall@k.
 */
function perScenarioMatrix(reports: Array<{ arm: Arm; report: EvalReport }>): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const scenarioIds = reports[0]?.report.perScenario.map((s) => s.id) ?? [];
  const idW = Math.max(8, ...scenarioIds.map((id) => id.length));
  const colW = 11;
  const lines: string[] = [];
  lines.push('');
  lines.push('Per-scenario recall@k by arm  (multi-hop scenarios show the PPR lift)');
  lines.push('─'.repeat(idW + 2 + reports.length * (colW + 1)));
  lines.push(
    `  ${'scenario'.padEnd(idW)} ${reports.map((r) => ARM_LABEL[r.arm].padStart(colW)).join(' ')}`,
  );
  lines.push('─'.repeat(idW + 2 + reports.length * (colW + 1)));
  for (const id of scenarioIds) {
    const cells = reports.map((r) => {
      const row = r.report.perScenario.find((s) => s.id === id);
      return (row ? pct(row.recallAtK) : '—').padStart(colW);
    });
    lines.push(`  ${id.padEnd(idW)} ${cells.join(' ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Real-vault benchmark mode — a different measurement entirely (retrieval
  // quality + latency over a local snapshot, no temporal labels). Bypasses the
  // JSONL dataset path. See eval/real-vault.ts.
  if (args.realVault) {
    const { runRealVaultBenchmark, formatRealVaultReport } = await import('./real-vault.js');
    const arms = parseArms(args.arms);
    const report = await runRealVaultBenchmark({
      vaultDir: args.realVault,
      k: args.k,
      arms,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(formatRealVaultReport(report) + '\n');

    // Persist for the dashboard. Real-vault arms (lexical/semantic/ppr) map onto
    // the RetrievalQualityArm arm space: lexical/semantic → baseline (the
    // untreated pipeline), ppr → ppr. PIT/leak don't apply here (0); MRR/latency
    // carry through. Prefer the multi-hop gold set (the PPR-relevant signal),
    // else self-retrieval.
    const rvRows = realVaultArmRows(report);
    await persistEvalReport(args.out, 'real-vault', report.k, rvRows);
    return;
  }

  const datasetPath = args.smoke ? smokeFixturePath() : args.dataset;
  if (!datasetPath) {
    process.stderr.write(
      'Usage:\n' +
        '  eval --dataset <path.jsonl> [--k N] [--bitemporal | --graph | --compare]\n' +
        '  eval --smoke [--bitemporal | --graph | --compare]\n' +
        '  eval --real-vault <dir> [--k N] [--arms lexical,semantic,ppr]\n',
    );
    process.exit(2);
    return;
  }

  const dataset = await loadDataset(datasetPath);

  if (args.compare) {
    // Run every arm over the SAME dataset, each in its OWN child process. A
    // single process cannot host multiple arms: config.ts / vault / search / the
    // KG module read env (vault path, data dir, BITEMPORAL_KG flag) at
    // module-load and cache it for the process lifetime, so a second in-process
    // run would reuse the first arm's frozen config (and its already-cleaned
    // temp vault). Separate processes give each arm a clean module graph +
    // isolated vault. baseline is the delta reference.
    const arms: Arm[] = ['baseline', 'bitemporal', 'ppr', 'ppr-bitemporal'];
    const reports: Array<{ arm: Arm; report: EvalReport }> = [];
    for (const arm of arms) {
      reports.push({ arm, report: await runArmSubprocess(arm, datasetPath, args.k) });
    }

    const byArm = Object.fromEntries(reports.map((r) => [r.arm, r.report]));
    const baseline = byArm.baseline;
    const treatments = reports.filter((r) => r.arm !== 'baseline');

    process.stdout.write(JSON.stringify(byArm, null, 2) + '\n');
    for (const { arm, report } of reports) {
      process.stdout.write(humanTable(report, ARM_LABEL[arm]) + '\n');
    }
    process.stdout.write(perScenarioMatrix(reports) + '\n');
    process.stdout.write(compareTable(baseline, treatments) + '\n');

    // Persist the full arm-compare for the dashboard's Recall-Quality hero.
    await persistEvalReport(
      args.out,
      'temporal',
      baseline.k,
      reports.map(({ arm, report }) => temporalArmRow(arm, report)),
    );
    return;
  }

  // Single-arm run: default retriever = REAL cortexmd pipeline over an isolated
  // temp vault. `--bitemporal` / `--graph` flip the respective features on.
  const report = await runHarness(dataset, {
    k: args.k,
    bitemporal: args.bitemporal,
    graph: args.graph,
  });

  // `--compare` spawns this entrypoint per arm and needs to parse the report
  // back out of stdout. In that internal mode emit ONLY a single fenced JSON
  // line so the parent can find it unambiguously amid the pipeline's log noise.
  if (process.env.EVAL_REPORT_JSON === '1') {
    process.stdout.write(REPORT_MARKER + JSON.stringify(report) + '\n');
    return;
  }

  const arm: Arm = args.graph && args.bitemporal ? 'ppr-bitemporal'
    : args.graph ? 'ppr'
    : args.bitemporal ? 'bitemporal'
    : 'baseline';
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(humanTable(report, ARM_LABEL[arm]) + '\n');

  // Persist the single-arm report for the dashboard. (Skipped above for the
  // EVAL_REPORT_JSON subprocess mode, which returns before reaching here.)
  await persistEvalReport(args.out, 'temporal', report.k, [temporalArmRow(arm, report)]);
}

/** Parse a `--arms lexical,semantic,ppr` list; default all three. */
function parseArms(raw: string | undefined): Array<'lexical' | 'semantic' | 'ppr'> {
  const valid = new Set(['lexical', 'semantic', 'ppr']);
  if (!raw) return ['lexical', 'semantic', 'ppr'];
  const arms = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => valid.has(s)) as Array<'lexical' | 'semantic' | 'ppr'>;
  return arms.length > 0 ? arms : ['lexical', 'semantic', 'ppr'];
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
  arm: Arm,
  datasetPath: string,
  k: number,
): Promise<EvalReport> {
  const { spawn } = await import('node:child_process');
  const selfPath = fileURLToPath(import.meta.url);
  const argv = [selfPath, '--dataset', datasetPath, '--k', String(k)];
  const { bitemporal, graph } = armFlags(arm);
  if (bitemporal) argv.push('--bitemporal');
  if (graph) argv.push('--graph');

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
        // compare / cross-contaminate the arm selection. The child's arm is set
        // purely by the explicit --bitemporal / --graph argv flags above.
        EVAL_COMPARE: '',
        EVAL_BITEMPORAL: '',
        EVAL_GRAPH: '',
        EVAL_SMOKE: '',
        EVAL_DATASET: '',
        EVAL_K: '',
        EVAL_REAL_VAULT: '',
        EVAL_ARMS: '',
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
