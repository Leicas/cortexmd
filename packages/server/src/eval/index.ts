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
 *   NOTE: `npm run eval -- --flag` drops the flags on some platforms (the
 *   Windows npm cmd shim). Env fallbacks cover that case:
 *     EVAL_SMOKE=1 npm run eval
 *     EVAL_DATASET=path.jsonl EVAL_K=10 npm run eval
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
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--smoke') args.smoke = true;
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
function humanTable(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('');
  lines.push(`Temporal recall eval  (k=${report.k}, scenarios=${report.nScenarios}, queries=${report.nQueries})`);
  lines.push('─'.repeat(64));
  lines.push(`  recall@k             ${pct(report.recallAtK)}`);
  lines.push(`  pointInTimeAccuracy  ${pct(report.pointInTimeAccuracy)}   (baseline — no bitemporal model yet)`);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const datasetPath = args.smoke ? smokeFixturePath() : args.dataset;
  if (!datasetPath) {
    process.stderr.write('Usage: eval --dataset <path.jsonl> [--k N] | eval --smoke\n');
    process.exit(2);
    return;
  }

  const dataset = await loadDataset(datasetPath);
  // Default retriever = REAL cortexmd pipeline over an isolated temp vault.
  const report = await runHarness(dataset, { k: args.k });

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(humanTable(report) + '\n');
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
