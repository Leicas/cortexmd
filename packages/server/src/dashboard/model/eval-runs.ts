/**
 * Recall Lab — eval run reader. Reads the per-run JSON files the recall eval
 * harness writes (default `<server pkg>/.realvault-eval/results/*.json`,
 * override with `RECALL_EVAL_RESULTS_DIR`). The harness schema is owned by
 * `src/eval/recall-eval.ts`; this reader is deliberately DEFENSIVE — it accepts
 * several key spellings for each metric and silently skips files it cannot
 * parse, so a schema tweak degrades a column to "—" instead of crashing.
 *
 * Only aggregate numbers + per-query ids/queries/ranks are returned to the
 * browser. Nothing here is written anywhere.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EvalMetrics { recallAt5: number | null; mrr: number | null; p95Ms: number | null; n: number | null }
export interface EvalQueryRow { key: string; query: string; category: string; hit: boolean | null; rr: number | null; rank: number | null; latencyMs: number | null }
export interface EvalRunSummary {
  id: string; file: string; ts: string; label: string;
  overall: EvalMetrics;
  categories: Record<string, EvalMetrics>;
  queryCount: number;
}
export interface EvalRun extends EvalRunSummary { queries: EvalQueryRow[] }

/** `<server package>/.realvault-eval/results` — resolved from this module (src/ or dist/). */
export function defaultResultsDir(): string {
  const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
  return nodePath.join(pkgRoot, '.realvault-eval', 'results');
}

export function resultsDir(): string {
  return process.env.RECALL_EVAL_RESULTS_DIR || defaultResultsDir();
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** First numeric value among `keys` (supports dotted paths). */
function pick(o: Obj | undefined, keys: string[]): number | null {
  if (!o) return null;
  for (const k of keys) {
    let cur: unknown = o;
    for (const part of k.split('.')) cur = isObj(cur) ? cur[part] : undefined;
    const n = num(cur);
    if (n != null) return n;
  }
  return null;
}

const R5 = ['recallAt5', 'recall@5', 'recall_at_5', 'recallAtK', 'recall5', 'r5', 'recall.at5', 'recall'];
const MRR = ['mrr', 'MRR', 'mrr10', 'mrrAt10', 'meanReciprocalRank'];
const P95 = ['p95Ms', 'p95LatencyMs', 'p95', 'latencyP95', 'p95_ms', 'latencyP95Ms', 'latency.p95', 'latency.p95Ms'];
const N = ['n', 'count', 'queries', 'queryCount', 'total'];

export function metricsOf(o: Obj | undefined): EvalMetrics {
  return { recallAt5: pick(o, R5), mrr: pick(o, MRR), p95Ms: pick(o, P95), n: pick(o, N) };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function normalizeRun(obj: unknown, file: string, mtime: Date): EvalRun | null {
  if (!isObj(obj)) return null;
  const overallSrc = [obj.metrics, obj.summary, obj.overall, obj.aggregate].find(isObj) ?? obj;
  const overall = metricsOf(overallSrc as Obj);

  const categories: Record<string, EvalMetrics> = {};
  const catSrc = obj.perCategory ?? obj.byCategory ?? obj.categories ?? (isObj(overallSrc) ? (overallSrc as Obj).perCategory : undefined);
  if (isObj(catSrc)) {
    for (const [k, v] of Object.entries(catSrc)) if (isObj(v)) categories[k] = metricsOf(v);
  } else if (Array.isArray(catSrc)) {
    for (const v of catSrc) if (isObj(v)) {
      const name = str(v.category) ?? str(v.name);
      if (name) categories[name] = metricsOf(v);
    }
  }

  const qSrc = [obj.queries, obj.perQuery, obj.results, obj.items].find(Array.isArray) as unknown[] | undefined;
  const queries: EvalQueryRow[] = [];
  for (const [i, q] of (qSrc ?? []).entries()) {
    if (!isObj(q)) continue;
    const query = str(q.query) ?? str(q.q) ?? str(q.text) ?? '';
    const key = str(q.id) ?? str(q.queryId) ?? (query || `#${i}`);
    // recall-eval.ts PerQueryRecord: only `kind: 'scored'` rows carry retrieval
    // metrics (negatives / unscorable / error rows are listed but not scored).
    const kind = str(q.kind);
    const scored = !kind || kind === 'scored';
    const RANK_KEYS = ['rank', 'firstRelevantRank', 'hitRank', 'goldRank'];
    const sc = isObj(q.score) ? q.score : undefined;
    const goldRanks = sc && Array.isArray(sc.goldRanks)
      ? (sc.goldRanks as unknown[]).map(num).filter((v): v is number => v != null && v > 0) : null;
    const rank = !scored ? null : goldRanks ? (goldRanks.length ? Math.min(...goldRanks) : null) : pick(q, RANK_KEYS);
    // An explicit `rank: null` (or 0) means the gold note was not retrieved.
    const missed = !scored ? false : rank == null
      ? (goldRanks != null || RANK_KEYS.some((k) => k in q && (q[k] === null || q[k] === 0))) : rank <= 0;
    let rr = scored ? pick(q, ['rr', 'reciprocalRank', 'score.reciprocalRank', 'mrr']) : null;
    if (rr == null && missed) rr = 0;
    if (rr == null && rank != null) rr = rank > 0 ? 1 / rank : 0;
    let hit: boolean | null = typeof q.hit === 'boolean' ? q.hit
      : typeof q.recallAt5 === 'boolean' ? q.recallAt5
      : typeof q.found === 'boolean' ? q.found : null;
    if (hit == null && scored) {
      const r5 = pick(q, ['score.recallAt5', ...R5]);
      if (r5 != null) hit = r5 > 0;
      else if (rank != null) hit = rank > 0 && rank <= 5;
      else if (missed) hit = false;
    }
    queries.push({
      key, query, category: str(q.category) ?? str(q.kind) ?? 'uncategorized',
      hit, rr, rank, latencyMs: pick(q, ['latencyMs', 'ms', 'latency', 'durationMs']),
    });
  }

  // Derive overall / per-category from queries when the file omits them.
  if (queries.length && overall.recallAt5 == null && overall.mrr == null) Object.assign(overall, aggregate(queries));
  if (queries.length && Object.keys(categories).length === 0) {
    const byCat = new Map<string, EvalQueryRow[]>();
    for (const q of queries) byCat.set(q.category, [...(byCat.get(q.category) ?? []), q]);
    for (const [k, rows] of byCat) categories[k] = aggregate(rows);
  }
  if (overall.n == null) overall.n = queries.length || null;

  const ts = str(obj.timestamp) ?? str(obj.startedAt) ?? str(obj.createdAt) ?? str(obj.date) ?? str(obj.finishedAt) ?? mtime.toISOString();
  const label = str(obj.label) ?? str(obj.name) ?? str(obj.arm) ?? str(obj.variant)
    ?? (isObj(obj.config) ? str((obj.config as Obj).name) ?? str((obj.config as Obj).arm) : undefined)
    ?? str(obj.commit) ?? file.replace(/\.json$/, '');
  return { id: file.replace(/\.json$/, ''), file, ts, label, overall, categories, queryCount: queries.length, queries };
}

export function aggregate(rows: EvalQueryRow[]): EvalMetrics {
  const hits = rows.filter((r) => r.hit != null);
  const rrs = rows.filter((r) => r.rr != null);
  const lat = rows.map((r) => r.latencyMs).filter((v): v is number => v != null).sort((a, b) => a - b);
  return {
    recallAt5: hits.length ? hits.filter((r) => r.hit).length / hits.length : null,
    mrr: rrs.length ? rrs.reduce((a, r) => a + (r.rr ?? 0), 0) / rrs.length : null,
    p95Ms: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null,
    n: rows.length,
  };
}

/** All parseable runs, oldest → newest. */
export function readEvalRuns(dir = resultsDir()): EvalRun[] {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const runs: EvalRun[] = [];
  for (const f of files) {
    try {
      const full = nodePath.join(dir, f);
      const st = statSync(full);
      if (st.size > 50 * 1024 * 1024) continue;
      const obj = JSON.parse(readFileSync(full, 'utf8')) as unknown;
      // recall-eval.ts writes one file per run with several arms
      // ({label, createdAt, arms:[{arm, overall, byCategory, perQuery}]}):
      // each arm becomes its own row so arms can be compared like runs.
      if (isObj(obj) && Array.isArray(obj.arms) && obj.arms.some((a) => isObj(a) && isObj((a as Obj).overall))) {
        for (const a of obj.arms) {
          if (!isObj(a)) continue;
          const arm = str(a.arm) ?? 'arm';
          const run = normalizeRun({
            ...a,
            label: `${str(obj.label) ?? f.replace(/\.json$/, '')} · ${arm}`,
            createdAt: str(obj.createdAt) ?? str(obj.timestamp),
            arms: undefined,
          }, f, st.mtime);
          if (run) { run.id = `${run.id}#${arm}`; runs.push(run); }
        }
        continue;
      }
      const run = normalizeRun(obj, f, st.mtime);
      if (run) runs.push(run);
    } catch { /* skip unreadable / partial file */ }
  }
  return runs.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function summarize(run: EvalRun): EvalRunSummary {
  const { queries: _q, ...rest } = run;
  return rest;
}

export interface QueryDiff {
  key: string; query: string; category: string;
  baseRank: number | null; curRank: number | null;
  baseRr: number | null; curRr: number | null;
  baseHit: boolean | null; curHit: boolean | null;
  status: 'regressed' | 'improved' | 'same' | 'new' | 'dropped';
}

/** Per-query comparison of `cur` against `base`; regressions first. */
export function diffRuns(base: EvalRun, cur: EvalRun): QueryDiff[] {
  const bm = new Map(base.queries.map((q) => [q.key, q]));
  const cm = new Map(cur.queries.map((q) => [q.key, q]));
  const out: QueryDiff[] = [];
  for (const [key, c] of cm) {
    const b = bm.get(key);
    let status: QueryDiff['status'] = 'new';
    if (b) {
      const lostHit = b.hit === true && c.hit === false;
      const gainHit = b.hit === false && c.hit === true;
      const drr = (c.rr ?? 0) - (b.rr ?? 0);
      status = lostHit || drr < -1e-9 ? 'regressed' : gainHit || drr > 1e-9 ? 'improved' : 'same';
    }
    out.push({ key, query: c.query, category: c.category, baseRank: b?.rank ?? null, curRank: c.rank,
      baseRr: b?.rr ?? null, curRr: c.rr, baseHit: b?.hit ?? null, curHit: c.hit, status });
  }
  for (const [key, b] of bm) if (!cm.has(key)) {
    out.push({ key, query: b.query, category: b.category, baseRank: b.rank, curRank: null,
      baseRr: b.rr, curRr: null, baseHit: b.hit, curHit: null, status: 'dropped' });
  }
  const order = { regressed: 0, dropped: 1, improved: 2, new: 3, same: 4 } as const;
  return out.sort((a, b) => order[a.status] - order[b.status]
    || ((a.curRr ?? 0) - (a.baseRr ?? 0)) - ((b.curRr ?? 0) - (b.baseRr ?? 0)));
}
