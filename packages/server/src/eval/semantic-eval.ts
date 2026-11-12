/**
 * ============================================================================
 * eval:semantic — embedding-model / chunking / cross-encoder A/B harness
 * ============================================================================
 *
 *   npx tsx src/eval/semantic-eval.ts [--vault DIR] [--dataset DIR|FILE]
 *       [--label NAME] [--data-dir DIR] [--arms vector,noprior30,rerank]
 *       [--pool 30] [--reranker MODEL_ID] [--passage chunk|lead]
 *       [--rerank-timeout MS] [--limit N] [--verbose]
 *
 * Companion to eval:recall (same dataset, vault guard and result shape — a
 * result file can be diffed with the same tooling) for what the recall arms
 * cannot isolate:
 *
 *   vector     pure vector ranking: searchSemantic → notes in recall scope
 *              (type:memory). No lexical arm, no fusion — measures the
 *              embedding model + chunking alone.
 *   noprior30  the noprior recall arm fetched at --pool depth, scored on its
 *              top 10 (the rerank baseline).
 *   rerank     the same pool reranked by lib/cross-encoder.ts, passage = title
 *              + the note's best-matching chunk for the query; reports the
 *              added latency separately.
 *
 * The embedding model, chunking and cross-encoder are configured through the
 * normal env (EMBEDDING_MODEL, EMBEDDING_CHUNKING, CROSS_ENCODER_MODEL, …).
 * Use a dedicated --data-dir per configuration: caches are per DATA_DIR.
 * Also reports embedding build time, vector count, on-disk index size, RSS
 * and uncached query-embed latency.
 * ============================================================================
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  loadRecallDatasets, subsampleQueries, makeGoldResolver, runArm, formatArmTable,
  makeRecallRunner, DEFAULT_NOISE_PREFIXES, buildArmReport,
  type ArmReport, type ArmRunner, type RecallEvalQuery, type PerQueryRecord,
} from './recall-core.js';

type Arm = 'vector' | 'noprior30' | 'rerank';
const ALL_ARMS: Arm[] = ['vector', 'noprior30', 'rerank'];

const log = (msg: string) => process.stderr.write(`[eval:semantic] ${msg}\n`);

function parseArgs(argv: string[]) {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
  };
  const arms = (get('arms') ?? 'vector').split(',').map((s) => s.trim()).filter(Boolean) as Arm[];
  for (const a of arms) if (!ALL_ARMS.includes(a)) throw new Error(`unknown arm "${a}" (expected ${ALL_ARMS.join(',')})`);
  const limit = get('limit');
  return {
    vault: path.resolve(get('vault') ?? '.realvault-snapshot'),
    dataset: path.resolve(get('dataset') ?? '.realvault-eval/queries'),
    label: get('label') ?? `semantic-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    arms,
    dataDir: get('data-dir'),
    pool: parseInt(get('pool') ?? '30', 10),
    reranker: get('reranker'),
    passage: (get('passage') ?? 'chunk') as 'chunk' | 'lead',
    rerankTimeout: parseInt(get('rerank-timeout') ?? '0', 10),
    limit: limit ? parseInt(limit, 10) : undefined,
    verbose: argv.includes('--verbose'),
  };
}

function modifiedSince(dir: string, sinceMs: number, out: string[] = [], rel = ''): string[] {
  for (const ent of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (ent.name === '.git') continue;
      modifiedSince(dir, sinceMs, out, r);
    } else {
      try { if (statSync(path.join(dir, r)).mtimeMs >= sinceMs) out.push(r); } catch { /* vanished */ }
    }
  }
  return out;
}

const pctl = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** id → answer_depth ("deep" = the answer lies beyond the note's first ~1,000 chars). */
function loadAnswerDepth(target: string): Map<string, string> {
  const out = new Map<string, string>();
  const files = statSync(target).isDirectory()
    ? readdirSync(target).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(target, f))
    : [target];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row.id === 'string' && typeof row.answer_depth === 'string') out.set(row.id, row.answer_depth);
      } catch { /* dataset loader reports bad lines */ }
    }
  }
  return out;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (!existsSync(args.vault)) throw new Error(`vault dir not found: ${args.vault}`);
  if (!existsSync(args.dataset)) throw new Error(`dataset not found: ${args.dataset}`);
  if (!args.dataDir) throw new Error('--data-dir is required (one cache dir per embedding configuration)');
  const dataDir = path.resolve(args.dataDir);
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
  process.env.API_KEY ||= 'semantic-eval-local';
  process.env.DASHBOARD_PASSWORD ||= 'semantic-eval-local';
  process.env.ENABLE_KG = 'false';
  process.env.AUTO_LINK = 'false';
  process.env.AUTO_SEED_KG = 'false';
  process.env.CODE_AUTO_PROJECT_ON_RECALL = 'false';
  process.env.ENABLE_EMBEDDINGS = 'true';
  process.env.RECALL_NO_TOUCH = '1';
  if (args.reranker) process.env.CROSS_ENCODER_MODEL = args.reranker;
  if (!args.verbose) process.env.LOG_LEVEL ||= 'warn';

  const startedMs = Date.now();
  const ds = loadRecallDatasets(args.dataset);
  const queries: RecallEvalQuery[] = subsampleQueries(ds.queries, args.limit);
  if (queries.length === 0) { log('no queries'); return 2; }
  const depth = loadAnswerDepth(args.dataset);

  const { config } = await import('../config.js');
  const search = await import('../lib/search.js');
  let t0 = Date.now();
  await search.rebuildIndex();
  const docMeta = search.getDocMeta();
  log(`indexed ${docMeta.size} notes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const resolveGold = makeGoldResolver(docMeta);

  // ── Embeddings ──
  const emb = await import('../lib/embeddings.js');
  t0 = Date.now();
  await emb.initEmbeddings();
  const modelLoadMs = Date.now() - t0;
  if (!emb.isEmbeddingsReady()) { log('embedding model failed to load'); return 2; }
  const docs = new Map<string, { title: string; content: string }>();
  for (const [p, m] of docMeta) docs.set(p, { title: m.title, content: m.content });
  const persisted = emb.wasPersistedIndexLoaded();
  const before = emb.getEmbeddingStats();
  log(`${persisted ? 'syncing cached' : 'building'} index: model ${before.model} (${before.dimension}d), chunking ${before.chunking ? 'on' : 'off'}…`);
  t0 = Date.now();
  const timer = setInterval(() => {
    const s = emb.getEmbeddingStats();
    log(`  ${s.indexSize} notes / ${s.vectors} vectors, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }, 30000);
  try {
    if (persisted) await emb.syncIndexIncremental(docs);
    else await emb.buildFullIndex(docs);
  } finally { clearInterval(timer); }
  const buildMs = Date.now() - t0;
  const st = emb.getEmbeddingStats();
  const embFiles = readdirSync(config.embeddingsDataDir)
    .filter((f) => /^(index|id-map).*\.(hnsw|json)$/.test(f))
    .map((f) => ({ file: f, bytes: statSync(path.join(config.embeddingsDataDir, f)).size }));
  const newVectors = st.vectors - (persisted ? before.vectors : 0);
  log(`index ready: ${st.indexSize} notes, ${st.vectors} vectors (${newVectors} embedded this run) in ${(buildMs / 1000).toFixed(0)}s`);

  // Uncached query-embed latency.
  const qLat: number[] = [];
  for (const q of queries.slice(0, 100)) {
    const t = performance.now();
    await emb.embedText(q.query + ' ', { kind: 'query' });
    qLat.push(performance.now() - t);
  }

  // ── Arms ──
  const reports: ArmReport[] = [];
  const measure = async (arm: string, runner: ArmRunner) => {
    try { await runner(queries[0].query); } catch { /* warm-up */ }
    const t = Date.now();
    const rep = await runArm(arm, queries, runner, { resolveGold, noisePrefixes: DEFAULT_NOISE_PREFIXES });
    log(`${arm}: ${((Date.now() - t) / 1000).toFixed(1)}s`);
    reports.push(rep);
    return rep;
  };

  if (args.arms.includes('vector')) {
    await measure('vector', async (query) => {
      const hits = await emb.searchSemantic(query, Math.max(200, config.semanticCandidates), { withText: false });
      const paths: string[] = [];
      for (const h of hits) {
        const m = docMeta.get(h.path);
        if (!m || m.type !== 'memory' || m.archived) continue;
        paths.push(h.path);
        if (paths.length >= 10) break;
      }
      return { paths };
    });
  }

  const rerankMs: number[] = [];
  let rerankFallbacks = 0;
  if (args.arms.includes('noprior30') || args.arms.includes('rerank')) {
    const poolRunner = await makeRecallRunner({ limit: args.pool, noPrior: true });
    const pools = new Map<string, string[]>();
    const pool = async (query: string): Promise<string[]> => {
      let p = pools.get(query);
      if (!p) { p = (await poolRunner(query)).paths; pools.set(query, p); }
      return p;
    };
    await measure('noprior30', async (query) => {
      pools.delete(query); // time the real recall, not the memo
      return { paths: (await pool(query)).slice(0, 10) };
    });
    if (args.arms.includes('rerank')) {
      const ce = await import('../lib/cross-encoder.js');
      // Load outside the timed region (first call downloads the model).
      t0 = Date.now();
      const warm = await ce.rerankPassages('warm-up', ['warm-up passage'], { force: true, timeoutMs: 0 });
      log(`cross-encoder ${warm.model}: ${warm.reranked ? 'loaded' : `FAILED (${warm.reason})`} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (!warm.reranked) return 2;
      await measure('rerank', async (query) => {
        const paths = await pool(query);
        const chunks = args.passage === 'chunk' ? await emb.bestChunksFor(query, paths) : new Map();
        const passages = paths.map((p) => {
          const m = docMeta.get(p);
          const body = chunks.get(p)?.text ?? (m?.content ?? '').slice(0, 1000);
          return `${m?.title ?? ''}\n${body}`.trim();
        });
        const r = await ce.rerankPassages(query, passages, { force: true, topK: args.pool, timeoutMs: args.rerankTimeout });
        rerankMs.push(r.ms);
        if (!r.reranked) rerankFallbacks++;
        return { paths: r.results.slice(0, 10).map((x) => paths[x.index]) };
      });
    }
  }

  // ── Slices ──
  const slice = (name: string, pred: (r: PerQueryRecord) => boolean) =>
    reports.map((rep) => ({ arm: rep.arm, slice: name, ...buildArmReport(rep.arm, rep.perQuery.filter(pred)).overall }));
  const slices = [
    ...slice('deep', (r) => depth.get(r.id) === 'deep'),
    ...slice('shallow', (r) => depth.get(r.id) === 'shallow'),
    ...slice('french*', (r) => r.category.startsWith('french')),
  ];

  const touched = modifiedSince(args.vault, startedMs);
  const mem = process.memoryUsage();
  const out = {
    label: args.label,
    createdAt: new Date().toISOString(),
    nNotes: docMeta.size,
    embedding: {
      model: st.model, dimension: st.dimension, dtype: config.embeddingDtype, chunking: st.chunking,
      notes: st.indexSize, vectors: st.vectors, embeddedThisRun: newVectors, startedFromCache: persisted,
      modelLoadMs, buildMs, vectorsPerSec: buildMs > 0 ? +(newVectors / (buildMs / 1000)).toFixed(1) : null,
      files: embFiles, rssMB: Math.round(mem.rss / 1e6),
      queryEmbedMs: { p50: +pctl(qLat, 0.5).toFixed(1), p95: +pctl(qLat, 0.95).toFixed(1) },
    },
    rerank: rerankMs.length
      ? { model: config.crossEncoderModel, pool: args.pool, passage: args.passage, fallbacks: rerankFallbacks,
          addedMs: { p50: pctl(rerankMs, 0.5), p95: pctl(rerankMs, 0.95) } }
      : undefined,
    dataset: { n: queries.length },
    vaultWrites: touched,
    slices,
    arms: reports,
  };
  const outPath = path.join(resultsDir, `${args.label}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 1));

  process.stdout.write(`\n=== semantic eval "${args.label}" — ${queries.length} queries, ${docMeta.size} notes ===\n`);
  process.stdout.write(`${JSON.stringify(out.embedding)}\n`);
  if (out.rerank) process.stdout.write(`rerank: ${JSON.stringify(out.rerank)}\n`);
  for (const r of reports) process.stdout.write(`\n${formatArmTable(r)}\n`);
  const fmt = (x: number | null) => (x === null ? '  -  ' : (x * 100).toFixed(1).padStart(5));
  process.stdout.write('\nslices (R@5 / MRR / top1):\n');
  for (const s of slices) {
    process.stdout.write(`  ${s.arm.padEnd(10)} ${s.slice.padEnd(8)} n=${String(s.nScored).padStart(3)}  ${fmt(s.recallAt5)}  ${s.mrr === null ? '  -  ' : s.mrr.toFixed(3)}  ${fmt(s.top1)}\n`);
  }
  process.stdout.write(`\nfull results: ${outPath}\n`);
  if (touched.length) { log(`ERROR: ${touched.length} vault files were modified during the run`); return 3; }
  return 0;
}

if (process.argv[1] && /semantic-eval\.(ts|js)$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
