/**
 * ============================================================================
 * eval:recall — regression benchmark through the REAL memory_recall path
 * ============================================================================
 *
 *   npm run eval:recall -- [--vault DIR] [--dataset DIR|FILE] [--label NAME]
 *       [--arms recall,noprior,lexical,semantic] [--embeddings on|off]
 *       [--limit N] [--compare results.json] [--noise-prefixes a/,b/]
 *       [--raw-scope memory|all] [--data-dir DIR] [--now auto|ISO] [--verbose]
 *
 * Defaults: --vault .realvault-snapshot, --dataset .realvault-eval/queries/,
 * --label run-<timestamp>, --arms recall, --embeddings on, --now auto (the
 * vault's latest note day: relative dates in queries stay reproducible on a
 * frozen snapshot; pass an ISO instant to pin it). Results go to
 * .realvault-eval/results/<label>.json (gitignored: real paths + queries).
 *
 * SAFETY: the vault dir is only READ. Recall runs with touch:false and
 * RECALL_NO_TOUCH=1 (no access bumps, no co-recall writes); config secrets are
 * pinned via env so config.ts never writes Ops/local-secrets.json into the
 * vault; a post-run mtime scan fails the run if anything in the vault changed.
 * Index/embedding caches persist in DATA_DIR (.realvault-eval/data/<vault>).
 * See docs/BENCHMARKS.md ("Recall eval").
 * ============================================================================
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  loadRecallDatasets, subsampleQueries, makeGoldResolver, runArm, formatArmTable,
  compareRuns, makeRecallRunner, makeRawSearchRunner, vaultReferenceNow, DEFAULT_NOISE_PREFIXES,
  type ArmReport, type ArmRunner, type RecallEvalQuery,
} from './recall-core.js';

type Arm = 'recall' | 'noprior' | 'lexical' | 'semantic';
const ALL_ARMS: Arm[] = ['recall', 'noprior', 'lexical', 'semantic'];

interface Args {
  vault: string;
  dataset: string;
  label: string;
  arms: Arm[];
  embeddings: boolean;
  limit?: number;
  compare?: string;
  noisePrefixes: string[];
  rawScope: 'memory' | 'all';
  dataDir?: string;
  /** 'auto' or an ISO instant. */
  now: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
  };
  const arms = (get('arms') ?? 'recall').split(',').map((s) => s.trim()).filter(Boolean) as Arm[];
  for (const a of arms) {
    if (!ALL_ARMS.includes(a)) throw new Error(`unknown arm "${a}" (expected ${ALL_ARMS.join(',')})`);
  }
  const emb = (get('embeddings') ?? 'on').toLowerCase();
  if (emb !== 'on' && emb !== 'off') throw new Error('--embeddings must be on|off');
  const limit = get('limit');
  const rawScope = (get('raw-scope') ?? 'memory') as 'memory' | 'all';
  return {
    vault: path.resolve(get('vault') ?? '.realvault-snapshot'),
    dataset: path.resolve(get('dataset') ?? '.realvault-eval/queries'),
    label: get('label') ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    arms,
    embeddings: emb === 'on',
    limit: limit ? parseInt(limit, 10) : undefined,
    compare: get('compare'),
    noisePrefixes: get('noise-prefixes')?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_NOISE_PREFIXES,
    rawScope: rawScope === 'all' ? 'all' : 'memory',
    dataDir: get('data-dir'),
    now: get('now') ?? 'auto',
    verbose: argv.includes('--verbose'),
  };
}

const log = (msg: string) => process.stderr.write(`[eval:recall] ${msg}\n`);

/** Files under `dir` modified at/after `sinceMs` (vault write guard). */
function modifiedSince(dir: string, sinceMs: number, out: string[] = [], rel = ''): string[] {
  for (const ent of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (ent.name === '.git') continue;
      modifiedSince(dir, sinceMs, out, r);
    } else {
      try {
        if (statSync(path.join(dir, r)).mtimeMs >= sinceMs) out.push(r);
      } catch { /* vanished */ }
    }
  }
  return out;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (!existsSync(args.vault)) throw new Error(`vault dir not found: ${args.vault}`);
  if (!existsSync(args.dataset)) throw new Error(`dataset not found: ${args.dataset}`);
  const dataDir = path.resolve(args.dataDir ?? path.join('.realvault-eval', 'data', path.basename(args.vault)));
  const resultsDir = path.resolve('.realvault-eval', 'results');
  mkdirSync(path.join(dataDir, 'embeddings'), { recursive: true });
  mkdirSync(resultsDir, { recursive: true });

  // ── Env BEFORE any pipeline import (config.ts freezes these at load) ──
  process.env.BRAIN_VAULT = args.vault;
  delete process.env.VAULT_RW;
  process.env.DATA_DIR = dataDir;
  process.env.EMBEDDINGS_DATA_DIR = path.join(dataDir, 'embeddings');
  delete process.env.SOURCE_VAULTS;
  delete process.env.VAULT_RO_PERSO;
  delete process.env.VAULT_RO_HAPLY;
  // Pinned so config.ts never generates + persists secrets into <vault>/Ops/.
  process.env.API_KEY ||= 'recall-eval-local';
  process.env.DASHBOARD_PASSWORD ||= 'recall-eval-local';
  process.env.ENABLE_KG = 'false';
  process.env.AUTO_LINK = 'false';
  process.env.AUTO_SEED_KG = 'false';
  process.env.CODE_AUTO_PROJECT_ON_RECALL = 'false';
  process.env.ENABLE_EMBEDDINGS = args.embeddings ? 'true' : 'false';
  process.env.RECALL_NO_TOUCH = '1';
  if (!args.verbose) process.env.LOG_LEVEL ||= 'warn';

  const startedMs = Date.now();

  // ── Dataset ──
  const ds = loadRecallDatasets(args.dataset);
  for (const w of ds.warnings) log(`dataset warning: ${w}`);
  const queries: RecallEvalQuery[] = subsampleQueries(ds.queries, args.limit);
  if (queries.length === 0) {
    log(`no queries found in ${args.dataset}`);
    return 2;
  }
  log(`dataset: ${queries.length}/${ds.queries.length} queries from ${ds.files.join(', ')}`);

  // ── Index ──
  const search = await import('../lib/search.js');
  let t0 = Date.now();
  await search.rebuildIndex();
  const docMeta = search.getDocMeta();
  const nMemory = [...docMeta.values()].filter((m) => m.type === 'memory').length;
  log(`indexed ${docMeta.size} notes (${nMemory} type:memory) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── Reference clock for relative-date queries ──
  const now = args.now === 'auto' ? vaultReferenceNow(docMeta) : new Date(args.now);
  if (Number.isNaN(now.getTime())) throw new Error(`--now must be "auto" or an ISO date, got "${args.now}"`);
  log(`reference clock: ${now.toISOString()} (${args.now === 'auto' ? 'latest note day' : 'pinned'})`);

  // ── Gold resolution report ──
  const resolveGold = makeGoldResolver(docMeta);
  const missingRows: Array<{ id: string; file: string; missing: string[] }> = [];
  let outOfScopeGold = 0;
  let totalGold = 0;
  const outOfScopeByCat: Record<string, number> = {};
  for (const q of queries) {
    const g = resolveGold(q.expected_paths);
    totalGold += g.gold.length;
    if (g.missing.length) missingRows.push({ id: q.id, file: q.file, missing: g.missing });
    if (g.outOfScope.length) {
      outOfScopeGold += g.outOfScope.length;
      outOfScopeByCat[q.category] = (outOfScopeByCat[q.category] ?? 0) + g.outOfScope.length;
    }
  }
  if (missingRows.length) {
    log(`WARNING: ${missingRows.length} rows have gold paths missing from the vault (dropped from scoring):`);
    for (const r of missingRows.slice(0, 20)) log(`  ${r.file} ${r.id}: ${r.missing.join(' | ')}`);
    if (missingRows.length > 20) log(`  … +${missingRows.length - 20} more (see JSON goldIssues)`);
  }
  log(`gold: ${totalGold} resolved paths, ${outOfScopeGold} outside memory_recall scope (not type:memory)` +
    (outOfScopeGold ? ` by category ${JSON.stringify(outOfScopeByCat)}` : ''));

  // ── Arms ──
  const reports: ArmReport[] = [];
  const progress = (arm: string) => (done: number, total: number) => {
    if (done % 25 === 0 || done === total) process.stderr.write(`\r[eval:recall] ${arm}: ${done}/${total}   ${done === total ? '\n' : ''}`);
  };
  const measure = async (arm: Arm, runner: ArmRunner) => {
    try { await runner(queries[0].query); } catch { /* warm-up only */ }
    t0 = Date.now();
    const rep = await runArm(arm, queries, runner, { resolveGold, noisePrefixes: args.noisePrefixes, onProgress: progress(arm) });
    log(`${arm}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    reports.push(rep);
  };

  // lexical must run BEFORE embeddings load (hybridSearch fuses vectors once ready).
  if (args.arms.includes('lexical')) {
    await measure('lexical', await makeRawSearchRunner({ limit: 10, scope: args.rawScope }));
  }

  let embeddingsStatus: 'off' | 'on' | 'failed' = 'off';
  if (args.embeddings) {
    const emb = await import('../lib/embeddings.js');
    t0 = Date.now();
    log('loading embedding model (first run downloads it into DATA_DIR)…');
    await emb.initEmbeddings();
    if (emb.isEmbeddingsReady()) {
      const docs = new Map<string, { title: string; content: string }>();
      for (const [p, m] of docMeta) docs.set(p, { title: m.title, content: m.content });
      const persisted = emb.wasPersistedIndexLoaded();
      log(`${persisted ? 'syncing cached' : 'building'} embedding index for ${docs.size} notes…`);
      const timer = setInterval(() => {
        log(`  embeddings: ${emb.getEmbeddingStats().indexSize} vectors, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }, 15000);
      try {
        if (persisted) await emb.syncIndexIncremental(docs);
        else await emb.buildFullIndex(docs);
      } finally {
        clearInterval(timer);
      }
      embeddingsStatus = emb.getEmbeddingStats().indexSize > 0 ? 'on' : 'failed';
      log(`embeddings ${embeddingsStatus}: ${emb.getEmbeddingStats().indexSize} vectors in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } else {
      embeddingsStatus = 'failed';
    }
    if (embeddingsStatus === 'failed') log('WARNING: embeddings failed — recall/noprior arms are LEXICAL-ONLY this run');
  }

  if (args.arms.includes('recall')) await measure('recall', await makeRecallRunner({ limit: 10, now }));
  if (args.arms.includes('noprior')) await measure('noprior', await makeRecallRunner({ limit: 10, noPrior: true, now }));
  if (args.arms.includes('semantic')) {
    if (embeddingsStatus === 'on') await measure('semantic', await makeRawSearchRunner({ limit: 10, scope: args.rawScope }));
    else log('semantic arm skipped (embeddings not loaded)');
  }

  // ── Vault write guard ──
  const touched = modifiedSince(args.vault, startedMs);

  // ── Output ──
  const byCat: Record<string, number> = {};
  for (const q of queries) byCat[q.category] = (byCat[q.category] ?? 0) + 1;
  const out = {
    label: args.label,
    createdAt: new Date().toISOString(),
    vault: args.vault,
    nNotes: docMeta.size,
    nMemoryNotes: nMemory,
    embeddings: embeddingsStatus,
    rawScope: args.rawScope,
    recallLimit: 10,
    now: now.toISOString(),
    noisePrefixes: args.noisePrefixes,
    dataset: { path: args.dataset, files: ds.files, nTotal: ds.queries.length, n: queries.length, byCategory: byCat, warnings: ds.warnings },
    goldIssues: { missingRows, outOfScopeGold, outOfScopeByCategory: outOfScopeByCat, totalResolvedGold: totalGold },
    vaultWrites: touched,
    arms: reports,
  };
  const outPath = path.join(resultsDir, `${args.label}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 1));

  process.stdout.write(`\n=== recall eval "${args.label}" — ${queries.length} queries, ${docMeta.size} notes, embeddings ${embeddingsStatus} ===\n`);
  for (const r of reports) process.stdout.write(`\n${formatArmTable(r)}\n`);
  process.stdout.write(`\nR@k/MRR/nDCG/top1 over scored queries; negAbs = negatives returning 0 results; noise5 = share of top-5 slots under ${args.noisePrefixes.join(', ')}; chars = mean rendered response size.\n`);
  process.stdout.write(`full results: ${outPath}\n`);

  let code = 0;
  if (touched.length) {
    log(`ERROR: ${touched.length} vault files were modified during the run: ${touched.slice(0, 5).join(', ')}`);
    code = 3;
  }
  if (args.compare) {
    const base = JSON.parse(readFileSync(path.resolve(args.compare), 'utf-8')) as typeof out;
    if (base.embeddings !== out.embeddings) log(`note: baseline embeddings=${base.embeddings}, current=${out.embeddings}`);
    const cmp = compareRuns(base, out);
    process.stdout.write(`\n=== compare vs ${args.compare} (pt = percentage points) ===\n${cmp.lines.join('\n')}\n`);
    if (cmp.failures.length) {
      process.stdout.write(`\nREGRESSION:\n${cmp.failures.map((f) => `  - ${f}`).join('\n')}\n`);
      code = code || 1;
    } else {
      process.stdout.write('\nno regression beyond thresholds\n');
    }
  }
  return code;
}

// CLI entry (not when imported by tests).
if (process.argv[1] && /recall-eval\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
