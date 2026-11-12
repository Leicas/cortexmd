/**
 * ============================================================================
 * Recall eval core — scores what `memory_recall` ACTUALLY returns
 * ============================================================================
 *
 * Shared by the `eval:recall` CLI (recall-eval.ts), `benchmark_run`
 * (lib/benchmark.ts) and the fixture test. Everything here is either PURE
 * (dataset parsing, path normalisation, metrics, aggregation, comparison) or a
 * runner factory that DYNAMICALLY imports the pipeline, so a caller can set
 * BRAIN_VAULT / DATA_DIR / ENABLE_EMBEDDINGS before config.ts freezes them.
 *
 * Arms (one ranked list of vault paths per query):
 *   recall    — `runMemoryRecall` from tools/memory-recall.ts: the exact MCP
 *               tool path (type:memory search, archived fallback, rescoreRecall
 *               priors, co-recall, MMR, render). touch:false → no side effects.
 *   noprior   — same path, but rescoreRecall is swapped for a relevance-only
 *               re-scorer (same scope filters + MMR, every prior multiplier = 1).
 *   lexical   — raw `hybridSearch` while embeddings are NOT loaded.
 *   semantic  — raw `hybridSearch` with embeddings loaded (lexical ⊕ vectors).
 * ============================================================================
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ── Dataset ────────────────────────────────────────────────────────────────

export interface RecallEvalQuery {
  id: string;
  query: string;
  /** Vault-relative note paths as written by the labeler (not normalised). */
  expected_paths: string[];
  category: string;
  lang?: string;
  source?: string;
  notes?: string;
  /** Dataset file the row came from (basename). */
  file: string;
}

export interface DatasetLoad {
  queries: RecallEvalQuery[];
  files: string[];
  warnings: string[];
}

/**
 * Load every `*.jsonl` under `target` (a dir) or the single file `target`.
 * Line schema: {"id","query","expected_paths":[...],"category","lang"?,
 * "source"?,"notes"?}. Bad lines are reported as warnings, never thrown.
 * Duplicate ids across files are disambiguated as `<file>:<id>`.
 */
export function loadRecallDatasets(target: string): DatasetLoad {
  const warnings: string[] = [];
  let files: string[];
  if (statSync(target).isDirectory()) {
    files = readdirSync(target)
      .filter((f) => f.toLowerCase().endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(target, f));
  } else {
    files = [target];
  }
  const queries: RecallEvalQuery[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const base = path.basename(file);
    const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        warnings.push(`${base}:${i + 1}: invalid JSON, skipped`);
        return;
      }
      const query = typeof row.query === 'string' ? row.query.trim() : '';
      if (!query) {
        warnings.push(`${base}:${i + 1}: missing "query", skipped`);
        return;
      }
      if (!Array.isArray(row.expected_paths) || !row.expected_paths.every((p) => typeof p === 'string')) {
        warnings.push(`${base}:${i + 1}: "expected_paths" must be a string array, skipped`);
        return;
      }
      const category = typeof row.category === 'string' && row.category.trim() ? row.category.trim() : 'uncategorized';
      let id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : `${base}:${i + 1}`;
      if (seen.has(id)) id = `${base}:${id}`;
      if (seen.has(id)) id = `${base}:${i + 1}`;
      seen.add(id);
      if (category !== 'negative' && row.expected_paths.length === 0) {
        warnings.push(`${base}:${i + 1} (${id}): non-negative row with empty expected_paths (unscorable)`);
      }
      queries.push({
        id,
        query,
        expected_paths: row.expected_paths as string[],
        category,
        lang: typeof row.lang === 'string' ? row.lang : undefined,
        source: typeof row.source === 'string' ? row.source : undefined,
        notes: typeof row.notes === 'string' ? row.notes : undefined,
        file: base,
      });
    });
  }
  return { queries, files: files.map((f) => path.basename(f)), warnings };
}

/** FNV-1a 32-bit — stable, dependency-free hash for deterministic sampling. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Reference clock for a vault: noon UTC on the most recent note day that is
 * not in the future. Makes relative-date queries reproducible on a frozen
 * snapshot (the wall clock keeps moving, the snapshot does not).
 */
export function vaultReferenceNow(vault: ReadonlyMap<string, { date?: string }>, wallClock: Date = new Date()): Date {
  const today = wallClock.toISOString().slice(0, 10);
  let latest = '';
  for (const m of vault.values()) {
    const d = typeof m.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(m.date) ? m.date.slice(0, 10) : '';
    if (d && d <= today && d > latest) latest = d;
  }
  return latest ? new Date(`${latest}T12:00:00Z`) : wallClock;
}

/**
 * Deterministic, category-stratified subsample: within each category order by
 * hash(id), then take round-robin across categories until `n` are picked.
 */
export function subsampleQueries(queries: RecallEvalQuery[], n?: number): RecallEvalQuery[] {
  if (n === undefined || n <= 0 || n >= queries.length) return queries;
  const byCat = new Map<string, RecallEvalQuery[]>();
  for (const q of queries) {
    const list = byCat.get(q.category) ?? [];
    list.push(q);
    byCat.set(q.category, list);
  }
  const lists = [...byCat.keys()].sort().map((c) =>
    byCat.get(c)!.sort((a, b) => fnv1a(a.id) - fnv1a(b.id) || a.id.localeCompare(b.id)));
  const out: RecallEvalQuery[] = [];
  for (let i = 0; out.length < n; i++) {
    for (const l of lists) {
      if (i < l.length && out.length < n) out.push(l[i]);
    }
  }
  return out;
}

// ── Path normalisation & gold resolution ──────────────────────────────────

/** Case-, `.md`-, slash- and leading-`./`-insensitive key for a vault path. */
export function normalizePathKey(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\.md$/i, '')
    .toLowerCase();
}

export interface ResolvedGold {
  /** Gold resolved to actual indexed vault paths. */
  gold: string[];
  /** Labeled paths that do not exist in the vault (dropped from scoring). */
  missing: string[];
  /** Resolved gold paths that are not `type: memory` (outside recall's scope). */
  outOfScope: string[];
}

/** Minimal note view: path → frontmatter `type`. */
export type VaultIndex = ReadonlyMap<string, { type?: string }>;

export function makeGoldResolver(vault: VaultIndex): (expected: string[]) => ResolvedGold {
  const byKey = new Map<string, string>();
  for (const p of vault.keys()) {
    const k = normalizePathKey(p);
    if (!byKey.has(k)) byKey.set(k, p);
  }
  return (expected) => {
    const gold: string[] = [];
    const missing: string[] = [];
    const outOfScope: string[] = [];
    for (const e of expected) {
      const actual = byKey.get(normalizePathKey(e));
      if (!actual) {
        missing.push(e);
        continue;
      }
      if (gold.includes(actual)) continue;
      gold.push(actual);
      if (vault.get(actual)?.type !== 'memory') outOfScope.push(actual);
    }
    return { gold, missing, outOfScope };
  };
}

// ── Per-query metrics ─────────────────────────────────────────────────────

export const DEFAULT_NOISE_PREFIXES = ['Memories/consolidated/', 'EmailLog/'];

export function isNoisePath(p: string, prefixes: string[]): boolean {
  const k = p.replace(/\\/g, '/').toLowerCase();
  return prefixes.some((pre) => k.startsWith(pre.replace(/\\/g, '/').toLowerCase()));
}

export interface QueryScore {
  recallAt5: number;
  recallAt10: number;
  reciprocalRank: number;
  ndcgAt10: number;
  top1: number;
  /** Noise paths among the top-5 returned. */
  noiseTop5: number;
  /** Returned slots among the top-5 (≤ 5). */
  slotsTop5: number;
  /** 1-based rank of each gold path in the returned list (null = not returned). */
  goldRanks: Array<number | null>;
}

/**
 * Score one ranked list against a resolved gold set. Binary relevance.
 * Ranks beyond the returned list (memory_recall returns ≤ limit) count as
 * misses, so MRR is MRR@limit.
 */
export function scoreQuery(ranked: string[], gold: string[], noisePrefixes: string[]): QueryScore {
  const goldSet = new Set(gold);
  const hitsAt = (k: number) => ranked.slice(0, k).filter((p) => goldSet.has(p)).length;
  const first = ranked.findIndex((p) => goldSet.has(p));
  let dcg = 0;
  ranked.slice(0, 10).forEach((p, i) => {
    if (goldSet.has(p)) dcg += 1 / Math.log2(i + 2);
  });
  let idcg = 0;
  for (let i = 0; i < Math.min(goldSet.size, 10); i++) idcg += 1 / Math.log2(i + 2);
  const top5 = ranked.slice(0, 5);
  return {
    recallAt5: goldSet.size ? hitsAt(5) / goldSet.size : 0,
    recallAt10: goldSet.size ? hitsAt(10) / goldSet.size : 0,
    reciprocalRank: first >= 0 ? 1 / (first + 1) : 0,
    ndcgAt10: idcg > 0 ? dcg / idcg : 0,
    top1: ranked.length > 0 && goldSet.has(ranked[0]) ? 1 : 0,
    noiseTop5: top5.filter((p) => isNoisePath(p, noisePrefixes)).length,
    slotsTop5: top5.length,
    goldRanks: gold.map((g) => {
      const i = ranked.indexOf(g);
      return i >= 0 ? i + 1 : null;
    }),
  };
}

// ── Arm run + aggregation ────────────────────────────────────────────────

export interface ArmOutput {
  paths: string[];
  /** Size of the response an agent would read (chars), when meaningful. */
  responseChars?: number;
}
export type ArmRunner = (query: string) => Promise<ArmOutput>;

export interface PerQueryRecord {
  id: string;
  category: string;
  lang?: string;
  file: string;
  query: string;
  gold: string[];
  missingGold: string[];
  outOfScopeGold: string[];
  /** 'scored' | 'negative' | 'unscorable' (no gold left in the vault) | 'error'. */
  kind: 'scored' | 'negative' | 'unscorable' | 'error';
  ranked: string[];
  score?: QueryScore;
  latencyMs: number;
  responseChars?: number;
  error?: string;
}

export interface Aggregate {
  /** All queries in the bucket (incl. negatives / unscorable). */
  n: number;
  /** Queries scored for retrieval metrics. */
  nScored: number;
  nNegative: number;
  nUnscorable: number;
  recallAt5: number | null;
  recallAt10: number | null;
  mrr: number | null;
  ndcgAt10: number | null;
  top1: number | null;
  /** Fraction of negative queries that returned zero results. */
  negAbstention: number | null;
  /** Share of returned top-5 slots that are noise paths (non-negative queries). */
  noiseTop5: number | null;
  p50LatencyMs: number;
  p95LatencyMs: number;
  meanResponseChars: number | null;
  meanResults: number;
}

export interface ArmReport {
  arm: string;
  overall: Aggregate;
  byCategory: Record<string, Aggregate>;
  perQuery: PerQueryRecord[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const mean = (xs: number[]): number | null => (xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function aggregateRecords(records: PerQueryRecord[]): Aggregate {
  const scored = records.filter((r) => r.kind === 'scored' && r.score);
  const negatives = records.filter((r) => r.kind === 'negative');
  const nonNeg = records.filter((r) => r.kind !== 'negative' && r.score);
  const lat = records.map((r) => r.latencyMs).sort((a, b) => a - b);
  const sizes = records.filter((r) => typeof r.responseChars === 'number').map((r) => r.responseChars as number);
  const slots = nonNeg.reduce((s, r) => s + (r.score?.slotsTop5 ?? 0), 0);
  const noise = nonNeg.reduce((s, r) => s + (r.score?.noiseTop5 ?? 0), 0);
  return {
    n: records.length,
    nScored: scored.length,
    nNegative: negatives.length,
    nUnscorable: records.filter((r) => r.kind === 'unscorable').length,
    recallAt5: mean(scored.map((r) => r.score!.recallAt5)),
    recallAt10: mean(scored.map((r) => r.score!.recallAt10)),
    mrr: mean(scored.map((r) => r.score!.reciprocalRank)),
    ndcgAt10: mean(scored.map((r) => r.score!.ndcgAt10)),
    top1: mean(scored.map((r) => r.score!.top1)),
    negAbstention: negatives.length ? r4(negatives.filter((r) => r.ranked.length === 0).length / negatives.length) : null,
    noiseTop5: slots > 0 ? r4(noise / slots) : null,
    p50LatencyMs: r4(quantile(lat, 0.5)),
    p95LatencyMs: r4(quantile(lat, 0.95)),
    meanResponseChars: sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : null,
    meanResults: mean(records.map((r) => r.ranked.length)) ?? 0,
  };
}

export function buildArmReport(arm: string, perQuery: PerQueryRecord[]): ArmReport {
  const cats = [...new Set(perQuery.map((r) => r.category))].sort();
  const byCategory: Record<string, Aggregate> = {};
  for (const c of cats) byCategory[c] = aggregateRecords(perQuery.filter((r) => r.category === c));
  return { arm, overall: aggregateRecords(perQuery), byCategory, perQuery };
}

export interface RunArmOptions {
  resolveGold: (expected: string[]) => ResolvedGold;
  noisePrefixes?: string[];
  /** Called after each query (progress). */
  onProgress?: (done: number, total: number) => void;
}

/** Run one arm over every query and score it. Never throws per query. */
export async function runArm(
  arm: string,
  queries: RecallEvalQuery[],
  runner: ArmRunner,
  opts: RunArmOptions,
): Promise<ArmReport> {
  const noise = opts.noisePrefixes ?? DEFAULT_NOISE_PREFIXES;
  const perQuery: PerQueryRecord[] = [];
  let done = 0;
  for (const q of queries) {
    const { gold, missing, outOfScope } = opts.resolveGold(q.expected_paths);
    const base = {
      id: q.id, category: q.category, lang: q.lang, file: q.file, query: q.query,
      gold, missingGold: missing, outOfScopeGold: outOfScope,
    };
    const t0 = performance.now();
    try {
      const out = await runner(q.query);
      const latencyMs = performance.now() - t0;
      const ranked = out.paths.slice(0, 10);
      const kind: PerQueryRecord['kind'] = q.category === 'negative'
        ? 'negative'
        : gold.length === 0 ? 'unscorable' : 'scored';
      perQuery.push({
        ...base, kind, ranked,
        score: kind === 'negative' ? undefined : scoreQuery(ranked, gold, noise),
        latencyMs: r4(latencyMs),
        responseChars: out.responseChars,
      });
    } catch (err) {
      perQuery.push({
        ...base, kind: 'error', ranked: [], latencyMs: r4(performance.now() - t0),
        error: err instanceof Error ? err.message : String(err),
      });
    }
    opts.onProgress?.(++done, queries.length);
  }
  return buildArmReport(arm, perQuery);
}

// ── Pipeline runners (dynamic imports: env must be set by the caller) ─────

export interface RecallRunnerOptions {
  /** memory_recall `limit` (default 10). */
  limit?: number;
  /** Swap rescoreRecall for the relevance-only re-scorer (noprior arm). */
  noPrior?: boolean;
  /**
   * "Now" for relative dates in queries ("last week", "yesterday"). A frozen
   * vault snapshot needs a frozen clock, or temporal rows drift with the
   * calendar. Default: the wall clock.
   */
  now?: Date;
}

/**
 * The real `memory_recall` path. Always touch:false — a measurement must not
 * bump access counters (vault writes) or co-recall state (later rankings).
 */
export async function makeRecallRunner(opts: RecallRunnerOptions = {}): Promise<ArmRunner> {
  const { runMemoryRecall } = await import('../tools/memory-recall.js');
  const rescore = opts.noPrior ? await makeRelevanceOnlyRescorer() : undefined;
  const limit = opts.limit ?? 10;
  return async (query) => {
    const r = await runMemoryRecall({ query, limit }, { touch: false, rescore, now: opts.now });
    return { paths: r.results.map((x) => x.path), responseChars: r.text.length };
  };
}

/**
 * Raw `hybridSearch` runner (lexical / semantic arms). `scope: 'memory'` uses
 * recall's candidate pool (type:memory, archived excluded); `'all'` searches
 * the whole vault.
 */
export async function makeRawSearchRunner(opts: { limit?: number; scope?: 'memory' | 'all' } = {}): Promise<ArmRunner> {
  const { hybridSearch } = await import('../lib/search.js');
  const limit = opts.limit ?? 10;
  const type = (opts.scope ?? 'memory') === 'memory' ? 'memory' : undefined;
  return async (query) => {
    const r = await hybridSearch(query, { limit, type });
    return { paths: r.map((x) => x.path) };
  };
}

/**
 * noprior arm re-scorer: identical scope filters to rescoreRecall (type
 * memory, category/temperature/importance filters, validity quarantine) and
 * the same MMR selection, but final score = fused relevance score — heat,
 * importance, recency, centrality, validity-staleness, archive penalty and
 * co-recall multipliers are all 1. Harness-side; the core is untouched.
 */
async function makeRelevanceOnlyRescorer() {
  const memory = await import('../lib/memory.js');
  const { getDocMeta } = await import('../lib/search.js');
  const { config } = await import('../config.js');
  const rescore: typeof memory.rescoreRecall = (results, o) => {
    const docMeta = getDocMeta();
    const cats = o.categories && o.categories.length > 0 ? o.categories : undefined;
    const temp = o.temperature ?? 'any';
    const order = memory.IMPORTANCE_ORDER as readonly string[];
    const minImp = o.minImportance ? order.indexOf(o.minImportance) : -1;
    const exclude = o.exclude ? new Set(o.exclude) : undefined;
    const out: ReturnType<typeof memory.rescoreRecall> = [];
    for (const r of results) {
      if (exclude?.has(r.path)) continue;
      const meta = docMeta.get(r.path);
      if (!meta || meta.type !== 'memory') continue;
      if (o.kinds && !o.kinds.has(meta.memory_kind)) continue;
      const category = meta.category || 'observation';
      const temperature = meta.temperature || 'warm';
      const importance = meta.importance || 'medium';
      if (cats && !cats.includes(category)) continue;
      if (temp !== 'any' && temperature !== temp) continue;
      if (minImp >= 0 && order.indexOf(importance) < minImp) continue;
      if (config.memoryValidity) {
        const v = memory.computeValidity({ validity_alpha: meta.validity_alpha, validity_beta: meta.validity_beta });
        if (v.quarantined) continue;
      }
      out.push({
        path: r.path, title: meta.title || r.title, category, temperature, importance,
        archived: meta.archived, consolidatedInto: meta.consolidated_into,
        score: r.score, lexicalScore: r.lexicalScore, semanticScore: r.semanticScore,
        fusedScore: r.fusedScore, snippet: (meta.content ?? '').slice(0, 200),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return memory.mmrSelect(out, o.limit);
  };
  return rescore;
}

// ── Reporting ────────────────────────────────────────────────────────────

const fmtPct = (x: number | null) => (x === null ? '   -  ' : `${(x * 100).toFixed(1).padStart(5)}%`);
const fmtMs = (x: number) => `${x.toFixed(0).padStart(5)}ms`;

function row(label: string, a: Aggregate): string {
  return [
    label.padEnd(22).slice(0, 22),
    String(a.n).padStart(4),
    String(a.nScored).padStart(4),
    fmtPct(a.recallAt5), fmtPct(a.recallAt10),
    a.mrr === null ? '   -  ' : a.mrr.toFixed(3).padStart(6),
    fmtPct(a.ndcgAt10), fmtPct(a.top1), fmtPct(a.negAbstention), fmtPct(a.noiseTop5),
    fmtMs(a.p50LatencyMs), fmtMs(a.p95LatencyMs),
    (a.meanResponseChars === null ? '-' : String(a.meanResponseChars)).padStart(6),
  ].join(' ');
}

export function formatArmTable(report: ArmReport): string {
  const head = [
    'category'.padEnd(22), '   n', ' scr', '   R@5', '  R@10', '   MRR', 'nDCG10', '  top1',
    ' negAbs', 'noise5', '   p50', '   p95', ' chars',
  ].join(' ');
  const lines = [`arm: ${report.arm}`, head, row('ALL', report.overall)];
  for (const [c, a] of Object.entries(report.byCategory)) lines.push(row(`  ${c}`, a));
  return lines.join('\n');
}

// ── Compare (regression gate) ────────────────────────────────────────────

export interface CompareThresholds {
  /** Max allowed absolute drop (0.02 = 2 points) in Recall@5 / MRR. */
  maxDrop: number;
  /** Categories with fewer current scored queries are not gated. */
  minQueries: number;
  /** Max allowed relative p95 regression (0.5 = +50%). */
  maxP95Regression: number;
  /** p95 regressions smaller than this (ms) are ignored as timer noise. */
  p95FloorMs: number;
}
export const DEFAULT_COMPARE: CompareThresholds = { maxDrop: 0.02, minQueries: 10, maxP95Regression: 0.5, p95FloorMs: 20 };

export interface CompareResult {
  lines: string[];
  failures: string[];
}

/**
 * Compare two runs arm-by-arm. Aggregates are RECOMPUTED over the query ids
 * present in both runs, so adding rows to the dataset does not read as a
 * regression. Fails on a Recall@5 or MRR drop > maxDrop in any category (or
 * ALL) with ≥ minQueries scored queries, or overall p95 > +maxP95Regression.
 */
export function compareRuns(
  base: { arms: ArmReport[] },
  cur: { arms: ArmReport[] },
  t: CompareThresholds = DEFAULT_COMPARE,
): CompareResult {
  const lines: string[] = [];
  const failures: string[] = [];
  const d = (a: number | null, b: number | null) =>
    a === null || b === null ? '     -' : `${b - a >= 0 ? '+' : ''}${((b - a) * 100).toFixed(1)}`.padStart(6);
  for (const curArm of cur.arms) {
    const baseArm = base.arms.find((a) => a.arm === curArm.arm);
    if (!baseArm) {
      lines.push(`arm ${curArm.arm}: not in baseline, skipped`);
      continue;
    }
    const baseIds = new Set(baseArm.perQuery.map((q) => q.id));
    const curIds = new Set(curArm.perQuery.map((q) => q.id));
    const common = (rs: PerQueryRecord[]) => rs.filter((q) => baseIds.has(q.id) && curIds.has(q.id));
    const b = buildArmReport(baseArm.arm, common(baseArm.perQuery));
    const c = buildArmReport(curArm.arm, common(curArm.perQuery));
    lines.push(`arm ${curArm.arm}: ${c.overall.n} common queries (baseline ${baseIds.size}, current ${curIds.size})`);
    lines.push(`  ${'category'.padEnd(22)}    n  dR@5(pt) dMRR(pt) dnDCG(pt) dtop1(pt)`);
    const cats: Array<[string, Aggregate, Aggregate | undefined]> = [['ALL', c.overall, b.overall]];
    for (const [cat, agg] of Object.entries(c.byCategory)) cats.push([cat, agg, b.byCategory[cat]]);
    for (const [cat, ca, ba] of cats) {
      if (!ba) continue;
      lines.push(`  ${cat.padEnd(22).slice(0, 22)} ${String(ca.nScored).padStart(4)}  ${d(ba.recallAt5, ca.recallAt5)}   ${d(ba.mrr, ca.mrr)}    ${d(ba.ndcgAt10, ca.ndcgAt10)}    ${d(ba.top1, ca.top1)}`);
      if (ca.nScored >= t.minQueries) {
        for (const [name, bv, cv] of [['Recall@5', ba.recallAt5, ca.recallAt5], ['MRR', ba.mrr, ca.mrr]] as const) {
          if (bv !== null && cv !== null && bv - cv > t.maxDrop + 1e-9) {
            failures.push(`${curArm.arm}/${cat}: ${name} ${(bv * 100).toFixed(1)} → ${(cv * 100).toFixed(1)} (−${((bv - cv) * 100).toFixed(1)}pt, n=${ca.nScored})`);
          }
        }
      }
    }
    const bp = b.overall.p95LatencyMs;
    const cp = c.overall.p95LatencyMs;
    lines.push(`  p95 latency ${bp.toFixed(0)}ms → ${cp.toFixed(0)}ms`);
    if (bp > 0 && cp > bp * (1 + t.maxP95Regression) && cp - bp > t.p95FloorMs) {
      failures.push(`${curArm.arm}: p95 latency ${bp.toFixed(0)}ms → ${cp.toFixed(0)}ms (+${(((cp - bp) / bp) * 100).toFixed(0)}%)`);
    }
  }
  return { lines, failures };
}
