/**
 * Lexical backend benchmark: MiniSearch (as configured in src/lib/search.ts)
 * vs the SQLite/FTS5 backend (src/lib/lexical-sqlite.ts).
 *
 *   # synthetic bilingual corpus (invented words — no real data)
 *   npx tsx scripts/bench-lexical.ts gen --n 10000 --out <dir>
 *   # one measurement in a fresh process (heap numbers are per process)
 *   node --expose-gc --max-old-space-size=4096 --import tsx scripts/bench-lexical.ts run \
 *        --backend minisearch|fts5|fts5-native|fts5-porter --corpus <dir> --data <dir> [--queries <dir>]
 *   # everything (spawns one child per backend × corpus) and prints a table
 *   npx tsx scripts/bench-lexical.ts all --scratch <dir> [--real .realvault-snapshot] [--queries .realvault-eval/queries] [--sizes 10000,50000,100000]
 *
 * MiniSearch options are REPLICATED from `createIndex()` in src/lib/search.ts
 * (it is not exported): fields title/content/tags, storeFields title, boost
 * title 3 / tags 2, processTerm = analyzeTerm, prefix/fuzzy = the length-gated
 * helpers from lib/text-analyzer.ts. Keep in sync if the ranking work changes them.
 *
 * Real-vault output is AGGREGATE ONLY (counts, latencies, R@5/MRR, overlap):
 * the script never prints a path, title or query from the real corpus.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import MiniSearch from 'minisearch';
import { analyzeTerm, fuzzyForTerm, prefixForTerm } from '../src/lib/text-analyzer.js';
import { SqliteLexicalBackend, type AnalyzerMode } from '../src/lib/lexical-sqlite.js';
import { bilingualAnalyzer } from '../src/lib/lexical/analyzer.js';
import { noteRecordFromMarkdown } from '../src/lib/lexical/record.js';
import type { LexicalFilters, ListingEntry, NoteRecord } from '../src/lib/lexical/types.js';
import { rankOverlap } from '../src/lib/lexical/shadow.js';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};

// ── Synthetic corpus ──────────────────────────────────────────────────────────

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ['ka', 'lo', 'mi', 'ter', 'van', 'su', 'ré', 'pol', 'dé', 'zan', 'qui', 'bor', 'né', 'fla', 'tri', 'gon',
  'ça', 'mu', 'pre', 'sel', 'or', 'ix', 'té', 'clo', 'ven', 'ar', 'bé', 'nu', 'sto', 'lan', 'eau', 'vis', 'cor'];
const EN_FILL = ['the', 'and', 'of', 'with', 'for', 'is', 'was', 'on', 'we', 'this', 'that', 'from', 'about'];
const FR_FILL = ['le', 'la', 'les', 'des', 'du', 'et', 'pour', 'avec', 'dans', 'est', 'une', 'sur', 'nous'];
const TYPES = ['memory', 'project', 'meeting', 'reference', 'daily'];
const CATS = ['decision', 'fact', 'preference', 'observation'];
const TEMPS = ['hot', 'warm', 'cold'];

function makeVocab(r: () => number, n: number): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    const k = 2 + Math.floor(r() * 3);
    let w = '';
    for (let i = 0; i < k; i++) w += SYL[Math.floor(r() * SYL.length)];
    if (r() < 0.25) w += 's';
    out.add(w);
  }
  return [...out];
}

function zipfPicker(r: () => number, n: number, s = 1.05): () => number {
  const cdf = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { sum += 1 / Math.pow(i + 1, s); cdf[i] = sum; }
  return () => {
    const x = r() * sum;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
}

function generate(n: number, out: string): void {
  const r = rng(42);
  const vocab = makeVocab(r, 40_000);
  const pick = zipfPicker(r, vocab.length);
  const tags = makeVocab(rng(7), 300);
  fs.mkdirSync(out, { recursive: true });
  for (let i = 0; i < n; i++) {
    const fr = r() < 0.5;
    const fill = fr ? FR_FILL : EN_FILL;
    const words = 80 + Math.floor(-Math.log(1 - r()) * 320); // ~400 words mean, long tail
    const body: string[] = [];
    for (let w = 0; w < words; w++) {
      body.push(r() < 0.3 ? fill[Math.floor(r() * fill.length)] : vocab[pick()]);
      if (r() < 0.07) body.push(r() < 0.5 ? '.\n' : ',');
    }
    const title = Array.from({ length: 2 + Math.floor(r() * 4) }, () => vocab[pick()]).join(' ');
    const nt = 1 + Math.floor(r() * 3);
    const t = Array.from({ length: nt }, () => tags[Math.floor(r() * tags.length)]);
    const date = new Date(Date.UTC(2023, 0, 1) + Math.floor(r() * 1400) * 86400000).toISOString().slice(0, 10);
    const fm = [
      '---', `title: "${title}"`, `tags: [${t.join(', ')}]`, `type: ${TYPES[i % TYPES.length]}`,
      `category: ${CATS[Math.floor(r() * CATS.length)]}`, `temperature: ${TEMPS[Math.floor(r() * 3)]}`,
      `heat_score: ${Math.floor(r() * 12)}`, `date: ${date}`, ...(r() < 0.05 ? ['archived: true'] : []), '---',
    ].join('\n');
    const dir = path.join(out, `d${String(i % 100).padStart(2, '0')}`);
    if (i < 100) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `note-${i}.md`), `${fm}\n${body.join(' ')}\n`);
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

async function listCorpus(root: string): Promise<ListingEntry[]> {
  const files = await glob('**/*.md', { cwd: root, nodir: true, posix: true });
  files.sort();
  const out: ListingEntry[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (next < files.length) {
      const p = files[next++];
      const s = await stat(path.join(root, p));
      out.push({ path: p, vault: root, mtimeMs: s.mtimeMs });
    }
  }));
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const mb = (b: number) => round(b / 1048576, 1);
const gc = () => { const g = (globalThis as { gc?: () => void }).gc; if (g) { g(); g(); } };

interface QuerySpec { cls: string; q: string; filters?: LexicalFilters }

/** Build latency query sets from the indexed corpus itself (deterministic). */
function buildQuerySet(records: Array<{ title: string; body: string; type?: string }>, n = 60): QuerySpec[] {
  const r = rng(99);
  const out: QuerySpec[] = [];
  const terms = (rec: { body: string }) => rec.body.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5 && !/\d/.test(w));
  for (let i = 0; i < n; i++) {
    const rec = records[Math.floor(r() * records.length)];
    const ws = terms(rec);
    if (ws.length < 6) { i--; continue; }
    const w = () => ws[Math.floor(r() * ws.length)];
    out.push({ cls: 'keyword', q: `${w()} ${w()}` });
    const start = Math.floor(r() * (ws.length - 4));
    out.push({ cls: 'phrase', q: ws.slice(start, start + 4).join(' ') });
    const long = ws.find((x) => x.length >= 7) ?? w();
    out.push({ cls: 'prefix', q: long.slice(0, 4) });
    const f = ws.find((x) => x.length >= 6) ?? w();
    const k = 1 + Math.floor(r() * (f.length - 2));
    out.push({ cls: 'fuzzy', q: f.slice(0, k) + (f[k] === 'x' ? 'y' : 'x') + f.slice(k + 1) });
    out.push({ cls: 'filtered', q: `${w()} ${w()}`, filters: { types: [rec.type ?? 'memory'], dateFrom: '2024-01-01', excludeArchived: true } });
  }
  return out;
}

// ── Backends under test ──────────────────────────────────────────────────────

interface Bench {
  build(listing: ListingEntry[]): Promise<{ maxSliceMs?: number; slowSlices?: number; slices?: number }>;
  warmBoot?(listing: ListingEntry[]): Promise<{ ms: number; maxSliceMs: number }>;
  search(q: string, limit: number, filters?: LexicalFilters): string[];
  dbBytes?(): number;
  close(): void;
}

function miniSearchBench(): Bench {
  // REPLICATED from src/lib/search.ts createIndex() (bilingual branch).
  const ms = new MiniSearch({
    fields: ['title', 'content', 'tags'],
    storeFields: ['title'],
    idField: 'id',
    processTerm: (term) => analyzeTerm(term),
    searchOptions: {
      boost: { title: 3, tags: 2 },
      prefix: (term) => prefixForTerm(term),
      fuzzy: (term) => fuzzyForTerm(term),
    },
  });
  // docMeta as search.ts holds it today: metadata AND the full body.
  const meta = new Map<string, NoteRecord>();
  const pass = (id: string, m: NoteRecord, f?: LexicalFilters) => {
    if ((f?.excludeArchived ?? true) && m.archived === true) return false;
    if (!f) return true;
    if (f.types?.length && (m.type === undefined || !f.types.includes(m.type))) return false;
    if (f.category && m.category !== f.category) return false;
    if (f.pathPrefixes?.length && !f.pathPrefixes.some((p) => id.startsWith(p))) return false;
    if (f.tagsAny?.length && !f.tagsAny.some((t) => m.tags.includes(t))) return false;
    if (m.date) {
      if (f.dateFrom && m.date < f.dateFrom) return false;
      if (f.dateTo && m.date > f.dateTo) return false;
    } else if (f.dateFrom || f.dateTo) return false;
    if (f.temperature && m.temperature !== f.temperature) return false;
    return true;
  };
  return {
    async build(listing) {
      // Same shape as search.ts runRebuild: bounded-concurrency reads, sync add per file.
      let next = 0;
      await Promise.all(Array.from({ length: 16 }, async () => {
        while (next < listing.length) {
          const e = listing[next++];
          let rec: NoteRecord;
          try {
            rec = noteRecordFromMarkdown(e.path, await readFile(path.join(e.vault, e.path), 'utf-8'));
          } catch { continue; } // unparseable frontmatter: skipped, as search.ts does
          meta.set(e.path, rec);
          ms.add({ id: e.path, title: rec.title, content: rec.body, tags: rec.tags.join(' ') });
        }
      }));
      return {};
    },
    search(q, limit, f) {
      const out: string[] = [];
      for (const r of ms.search(q)) {
        if (out.length >= limit) break;
        const m = meta.get(r.id as string);
        if (m && pass(r.id as string, m, f)) out.push(r.id as string);
      }
      return out;
    },
    close() { /* in-memory */ },
  };
}

function sqliteBench(dbPath: string, mode: AnalyzerMode): Bench {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  let b = new SqliteLexicalBackend({ dbPath, analyzer: mode });
  const load = (e: ListingEntry) => readFile(path.join(e.vault, e.path), 'utf-8');
  return {
    async build(listing) {
      const st = await b.syncFromListing(listing, load);
      return { maxSliceMs: st.maxSliceMs, slowSlices: st.slowSlices, slices: st.slices };
    },
    async warmBoot(listing) {
      b.close();
      const t0 = performance.now();
      b = new SqliteLexicalBackend({ dbPath, analyzer: mode });
      const st = await b.syncFromListing(listing, load);
      if (st.upserted !== 0) throw new Error(`warm boot re-indexed ${st.upserted} notes`);
      return { ms: performance.now() - t0, maxSliceMs: st.maxSliceMs };
    },
    search(q, limit, filters) { return b.search(q, { limit, filters }).map((h) => h.path); },
    dbBytes() { b.handle.pragma('wal_checkpoint(TRUNCATE)'); return b.stats().dbBytes ?? 0; },
    close() { b.close(); },
  };
}

// ── run: one backend over one corpus ─────────────────────────────────────────

interface RealQuery { query: string; expected_paths: string[] }

function loadRealQueries(dir: string | undefined): RealQuery[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const out: RealQuery[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line) as RealQuery);
    }
  }
  return out;
}

async function run(): Promise<void> {
  const backend = opt('backend', 'fts5')!;
  const corpus = path.resolve(opt('corpus')!);
  const data = path.resolve(opt('data')!);
  fs.mkdirSync(data, { recursive: true });
  gc();
  const base = process.memoryUsage();

  const tl = performance.now();
  const listing = await listCorpus(corpus);
  const listMs = performance.now() - tl;

  const modes: Record<string, AnalyzerMode> = {
    fts5: { kind: 'shared', analyze: bilingualAnalyzer, id: 'bilingual' },
    'fts5-native': { kind: 'native' },
    'fts5-porter': { kind: 'native', porter: true },
  };
  const bench = backend === 'minisearch' ? miniSearchBench() : sqliteBench(path.join(data, `${backend}.sqlite`), modes[backend]);

  const eld = monitorEventLoopDelay({ resolution: 5 });
  eld.enable();
  const t0 = performance.now();
  const built = await bench.build(listing);
  const buildMs = performance.now() - t0;
  eld.disable();
  const buildBlockMs = eld.max / 1e6;

  gc();
  const mem = process.memoryUsage();

  let warm: { ms: number; maxSliceMs: number } | undefined;
  if (bench.warmBoot) {
    const tw = performance.now();
    const l2 = await listCorpus(corpus); // a real warm boot re-lists + stats the vault
    const relist = performance.now() - tw;
    warm = await bench.warmBoot(l2);
    warm.ms += relist;
  }

  // Latency: query set derived from a sample of the corpus.
  const sample: Array<{ title: string; body: string; type?: string }> = [];
  const rs = rng(5);
  for (let i = 0; i < 300; i++) {
    const e = listing[Math.floor(rs() * listing.length)];
    let rec: NoteRecord;
    try { rec = noteRecordFromMarkdown(e.path, fs.readFileSync(path.join(e.vault, e.path), 'utf-8')); } catch { i--; continue; }
    sample.push({ title: rec.title, body: rec.body.slice(0, 4000), type: rec.type });
  }
  const qs = buildQuerySet(sample);
  for (const q of qs.slice(0, 20)) bench.search(q.q, 100, q.filters); // warm-up
  const lat: Record<string, number[]> = {};
  let maxQueryMs = 0;
  for (const q of qs) {
    const s = performance.now();
    bench.search(q.q, 100, q.filters);
    const d = performance.now() - s;
    (lat[q.cls] ??= []).push(d);
    if (d > maxQueryMs) maxQueryMs = d;
  }
  const latency: Record<string, { p50: number; p95: number }> = {};
  for (const [k, v] of Object.entries(lat)) latency[k] = { p50: round(pct(v, 0.5), 2), p95: round(pct(v, 0.95), 2) };

  // Ranking on real labelled queries (aggregate only).
  const real = loadRealQueries(opt('queries'));
  let rankings: string[][] | undefined;
  let r5 = 0, mrr = 0;
  if (real.length) {
    rankings = [];
    for (const q of real) {
      const top = bench.search(q.query, 10);
      rankings.push(top);
      const exp = new Set(q.expected_paths);
      if (top.slice(0, 5).some((p) => exp.has(p))) r5++;
      const rank = top.findIndex((p) => exp.has(p));
      if (rank >= 0) mrr += 1 / (rank + 1);
    }
    r5 /= real.length;
    mrr /= real.length;
    const rk = opt('rankings');
    if (rk) fs.writeFileSync(rk, JSON.stringify(rankings)); // stays in the scratch dir
  }

  const result = {
    backend,
    docs: listing.length,
    listMs: round(listMs),
    buildMs: round(buildMs),
    warmBootMs: warm ? round(warm.ms) : undefined,
    warmBootMaxSliceMs: warm ? round(warm.maxSliceMs) : undefined,
    heapUsedMB: mb(mem.heapUsed - base.heapUsed),
    rssMB: mb(mem.rss),
    externalMB: mb(mem.external),
    dbMB: bench.dbBytes ? mb(bench.dbBytes()) : undefined,
    buildMaxSliceMs: built.maxSliceMs !== undefined ? round(built.maxSliceMs) : undefined,
    buildSlices: built.slices,
    buildSlowSlices: built.slowSlices,
    buildEventLoopMaxMs: round(buildBlockMs),
    maxQueryMs: round(maxQueryMs),
    latency,
    real: real.length ? { queries: real.length, r5: round(r5, 3), mrr: round(mrr, 3) } : undefined,
  };
  bench.close();
  process.stdout.write(`@@RESULT ${JSON.stringify(result)}\n`);
}

// ── all: drive child processes and print the table ───────────────────────────

function child(params: string[]): Record<string, unknown> | null {
  const self = fileURLToPath(import.meta.url);
  const res = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=6144', '--import', 'tsx', self, 'run', ...params], {
    encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
  });
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('@@RESULT '));
  if (!line) {
    process.stderr.write(`child failed (${params.join(' ')}): ${(res.stderr ?? '').slice(-2000)}\n`);
    return null;
  }
  return JSON.parse(line.slice(9));
}

async function all(): Promise<void> {
  const scratch = path.resolve(opt('scratch')!);
  const sizes = (opt('sizes', '10000,50000,100000') ?? '').split(',').filter(Boolean).map(Number);
  const real = opt('real');
  const queries = opt('queries');
  const backends = (opt('backends', 'minisearch,fts5') ?? '').split(',');
  const emit = (row: Record<string, unknown>) => process.stdout.write(JSON.stringify(row) + '\n');

  if (real && fs.existsSync(real)) {
    const rankFiles: Record<string, string> = {};
    for (const be of [...backends, ...(opt('analyzers') ? opt('analyzers')!.split(',') : [])]) {
      const rk = path.join(scratch, `rank-${be}.json`);
      rankFiles[be] = rk;
      const r = child(['--backend', be, '--corpus', real, '--data', path.join(scratch, 'data-real'),
        ...(queries ? ['--queries', queries, '--rankings', rk] : [])]);
      if (r) emit({ corpus: 'real', ...r });
      process.stderr.write(`done real/${be}\n`);
    }
    // Baseline rankings: this run's MiniSearch, or a previous run's in the same scratch dir.
    const msRank = rankFiles.minisearch ?? path.join(scratch, 'rank-minisearch.json');
    if (queries && fs.existsSync(msRank)) {
      const base = JSON.parse(fs.readFileSync(msRank, 'utf-8')) as string[][];
      for (const [be, f] of Object.entries(rankFiles)) {
        if (be === 'minisearch' || !fs.existsSync(f)) continue;
        const other = JSON.parse(fs.readFileSync(f, 'utf-8')) as string[][];
        let ov = 0, t1 = 0;
        base.forEach((b, i) => { const o = rankOverlap(b, other[i] ?? [], 10); ov += o.overlap; if (o.top1) t1++; });
        process.stdout.write(`top10-overlap minisearch vs ${be}: ${round(ov / base.length, 3)} (top1 agree ${round(t1 / base.length, 3)}, n=${base.length})\n`);
      }
    }
  }
  for (const n of sizes) {
    const dir = path.join(scratch, `synth-${n}`);
    if (!fs.existsSync(path.join(dir, '.done'))) {
      process.stderr.write(`generating ${n} notes…\n`);
      generate(n, dir);
      fs.writeFileSync(path.join(dir, '.done'), '');
    }
    for (const be of backends) {
      const r = child(['--backend', be, '--corpus', dir, '--data', path.join(scratch, `data-${n}`)]);
      if (r) emit({ corpus: `synth-${n}`, ...r });
      process.stderr.write(`done synth-${n}/${be}\n`);
    }
  }
}

if (cmd === 'gen') generate(Number(opt('n', '10000')), path.resolve(opt('out')!));
else if (cmd === 'run') await run();
else if (cmd === 'all') await all();
else process.stderr.write('usage: bench-lexical.ts gen|run|all …\n');
