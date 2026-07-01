/**
 * ============================================================================
 * REAL-VAULT retrieval-quality benchmark
 * ============================================================================
 *
 * A companion to the synthetic temporal harness (runner.ts / index.ts). Where
 * that harness ingests a hand-authored timeline and scores point-in-time
 * correctness, THIS mode points the real cortexmd pipeline at a snapshot of an
 * ACTUAL vault (see scripts/snapshot-vault.mjs) and measures plain retrieval
 * quality + latency — the numbers that matter for the PPR graph-recall arm on
 * real data, where there are no temporal labels to score.
 *
 * ZERO HAND LABELS. The gold set is auto-derived from the vault's own
 * structure, so any snapshot is instantly benchmarkable:
 *
 *   (a) SELF-RETRIEVAL — query = a note's title; the single relevant doc is
 *       that note itself. Measures basic addressability: can the index find a
 *       note by its own name?
 *
 *   (b) MULTI-HOP proxy — query = a note's title; the relevant set is the notes
 *       its `[[wikilinks]]` resolve to. A note that links `[[Alice]]` and
 *       `[[Billing]]` should surface those neighbours. This is exactly the
 *       neighbour-reachability signal the PPR arm targets: wikilink + entity
 *       bridges should pull linked notes up the ranking. Notes with zero
 *       outbound links are excluded from (b) (no gold to score against).
 *
 * Metrics per arm: recall@k, MRR (1/rank of the first relevant hit), and
 * latency (avg + p95 ms/query). Arms map onto the SAME public surface as the
 * synthetic harness:
 *
 *   lexical   — embeddings OFF                          (MiniSearch only)
 *   semantic  — embeddings ON                           (lexical ⊕ vectors)
 *   ppr       — embeddings ON + graph:true              (adds the PPR arm)
 *
 * All arms run in ONE process over ONE indexed vault: unlike the temporal A/B
 * (which must isolate the frozen BITEMPORAL_KG flag per process), the arm
 * selection here is entirely per-CALL (`hybridSearch` opts) plus the
 * embeddings-ready flag, so a single build + many queries is correct and fast.
 * The one caveat: `lexical` results computed while embeddings are LOADED still
 * fuse the semantic arm, so we build the index once WITHOUT embeddings for the
 * lexical arm, then (if any arm needs them) load embeddings and re-measure the
 * semantic/ppr arms. See {@link runRealVaultBenchmark}.
 *
 * SAFETY: read-only. Points BRAIN_VAULT at the snapshot dir and DATA_DIR at a
 * throwaway temp dir; it never writes into the snapshot and never leaves the
 * machine. Same env-before-dynamic-import discipline as createRealRetriever.
 * ============================================================================
 */

import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type RealVaultArm = 'lexical' | 'semantic' | 'ppr';

export interface RealVaultOptions {
  /** The snapshot dir to benchmark (e.g. .realvault-snapshot/). */
  vaultDir: string;
  /** Top-k cutoff for recall@k / MRR. Default 10. */
  k?: number;
  /** Cap the number of notes turned into queries (sampled deterministically). */
  maxNotes?: number;
  /** Arms to measure. Default all three. 'semantic'/'ppr' load the model. */
  arms?: RealVaultArm[];
  /** Include the self-retrieval gold set (a). Default true. */
  includeSelfRetrieval?: boolean;
  /** Include the multi-hop wikilink-neighbour gold set (b). Default true. */
  includeMultiHop?: boolean;
}

/** One arm's scored result for one gold set. */
export interface RealVaultArmReport {
  arm: RealVaultArm;
  nQueries: number;
  recallAtK: number;
  mrr: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

export interface RealVaultReport {
  vaultDir: string;
  k: number;
  nNotes: number;
  arms: RealVaultArm[];
  /** One entry per arm; empty if includeSelfRetrieval is false. */
  selfRetrieval: RealVaultArmReport[];
  /** One entry per arm; empty if includeMultiHop is false or no linked notes. */
  multiHop: RealVaultArmReport[];
}

/**
 * One auto-derived query: a natural-language query string and the set of note
 * paths that count as relevant hits for it.
 */
export interface GoldQuery {
  query: string;
  /** Vault-relative note paths considered correct. Non-empty by construction. */
  relevant: Set<string>;
  /** Source note path (for debugging / dedup). */
  sourcePath: string;
}

/**
 * A minimal note view the gold-set derivation needs. Deliberately structural
 * (not the full DocMeta) so it is testable with hand-built fixtures.
 */
export interface GoldNote {
  path: string;
  title: string;
  /** Resolved wikilink neighbour paths (already resolved to indexed paths). */
  links: string[];
}

/**
 * Derive both gold sets from a set of notes + a resolved link graph. PURE — no
 * vault, no index. This is the seam the unit tests cover.
 *
 * - self-retrieval: query = title, relevant = {self}. Skips notes with an empty
 *   title (nothing to query by).
 * - multi-hop: query = title, relevant = resolved link targets. Skips notes
 *   with no resolved links (no gold). Self-links are dropped from the relevant
 *   set (a note linking itself is not a multi-hop signal).
 */
export function deriveGoldSets(
  notes: GoldNote[],
  opts: { includeSelfRetrieval?: boolean; includeMultiHop?: boolean } = {},
): { selfRetrieval: GoldQuery[]; multiHop: GoldQuery[] } {
  const includeSelf = opts.includeSelfRetrieval ?? true;
  const includeMulti = opts.includeMultiHop ?? true;

  const selfRetrieval: GoldQuery[] = [];
  const multiHop: GoldQuery[] = [];

  for (const note of notes) {
    const title = note.title.trim();
    if (!title) continue; // can't query a titleless note

    if (includeSelf) {
      selfRetrieval.push({
        query: title,
        relevant: new Set([note.path]),
        sourcePath: note.path,
      });
    }

    if (includeMulti) {
      const neighbours = new Set(note.links.filter((l) => l && l !== note.path));
      if (neighbours.size > 0) {
        multiHop.push({ query: title, relevant: neighbours, sourcePath: note.path });
      }
    }
  }

  return { selfRetrieval, multiHop };
}

/**
 * recall@k + MRR for a single ranked result list against a relevant set. PURE.
 *
 * - recall@k: fraction of the relevant set that appears in the top-k ranked
 *   paths. (For self-retrieval, |relevant| = 1, so this is hit/miss.)
 * - reciprocal rank: 1 / (1-based rank of the FIRST relevant path in the full
 *   ranking), or 0 if none appears. Uses the full ranking, not just top-k, so
 *   MRR degrades gracefully rather than snapping to 0 at the cutoff.
 */
export function scoreRanking(
  ranked: string[],
  relevant: Set<string>,
  k: number,
): { recall: number; reciprocalRank: number } {
  if (relevant.size === 0) return { recall: 0, reciprocalRank: 0 };
  const topK = ranked.slice(0, k);
  let hits = 0;
  for (const r of relevant) if (topK.includes(r)) hits++;
  const recall = hits / relevant.size;

  let reciprocalRank = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) {
      reciprocalRank = 1 / (i + 1);
      break;
    }
  }
  return { recall, reciprocalRank };
}

/** Aggregate per-query (recall, reciprocalRank, latencyMs) into an arm report. */
export function aggregateArm(
  arm: RealVaultArm,
  perQuery: Array<{ recall: number; reciprocalRank: number; latencyMs: number }>,
): RealVaultArmReport {
  const n = perQuery.length;
  if (n === 0) {
    return { arm, nQueries: 0, recallAtK: 0, mrr: 0, avgLatencyMs: 0, p95LatencyMs: 0 };
  }
  const round4 = (x: number) => Math.round(x * 10000) / 10000;
  const recall = perQuery.reduce((s, q) => s + q.recall, 0) / n;
  const mrr = perQuery.reduce((s, q) => s + q.reciprocalRank, 0) / n;
  const avgLatency = perQuery.reduce((s, q) => s + q.latencyMs, 0) / n;
  const sortedLat = perQuery.map((q) => q.latencyMs).sort((a, b) => a - b);
  // p95: nearest-rank method (ceil(0.95·n) - 1, clamped).
  const p95Idx = Math.min(sortedLat.length - 1, Math.max(0, Math.ceil(0.95 * n) - 1));
  return {
    arm,
    nQueries: n,
    recallAtK: round4(recall),
    mrr: round4(mrr),
    avgLatencyMs: round4(avgLatency),
    p95LatencyMs: round4(sortedLat[p95Idx]),
  };
}

/** hybridSearch opts for an arm (embeddings-ready is handled by build order). */
function armSearchOpts(arm: RealVaultArm, k: number): { limit: number; graph?: boolean } {
  // Fetch more than k so MRR can see relevant hits past the cutoff and so the
  // graph arm has room to re-rank neighbours into view.
  const limit = Math.max(k * 4, 40);
  return arm === 'ppr' ? { limit, graph: true } : { limit };
}

/**
 * Run the real-vault benchmark. Points the pipeline at `vaultDir`, indexes it
 * once, derives the gold sets from the indexed notes, and scores each arm.
 *
 * Build order matters for arm fidelity: the `lexical` arm must be measured with
 * embeddings NOT ready (so the semantic RRF term is genuinely absent), while
 * `semantic`/`ppr` need embeddings loaded. A single process cannot reload
 * config's frozen ENABLE_EMBEDDINGS flag, so we sequence within ONE build:
 * measure the `lexical` arm FIRST — before `initEmbeddings`, while
 * `searchSemantic` no-ops — then load embeddings and measure `semantic`/`ppr`.
 * If only `lexical` is requested the model is never loaded at all.
 */
export async function runRealVaultBenchmark(opts: RealVaultOptions): Promise<RealVaultReport> {
  const k = opts.k ?? 10;
  const arms = opts.arms ?? ['lexical', 'semantic', 'ppr'];
  const includeSelf = opts.includeSelfRetrieval ?? true;
  const includeMulti = opts.includeMultiHop ?? true;

  const wantsEmbeddings = arms.some((a) => a === 'semantic' || a === 'ppr');
  const wantsGraph = arms.includes('ppr');

  // Throwaway data dir so we never touch the developer's real indexes; the
  // snapshot dir itself is only ever READ (rebuildIndex walks it).
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'cortexmd-realvault-'));
  const dataDir = path.join(tmpRoot, 'data');
  const embeddingsDir = path.join(dataDir, 'embeddings');
  await mkdir(embeddingsDir, { recursive: true });

  // Env BEFORE the dynamic imports (config.ts freezes these at module load).
  process.env.BRAIN_VAULT = path.resolve(opts.vaultDir);
  process.env.DATA_DIR = dataDir;
  process.env.EMBEDDINGS_DATA_DIR = embeddingsDir;
  delete process.env.SOURCE_VAULTS;
  delete process.env.VAULT_RO_PERSO;
  delete process.env.VAULT_RO_HAPLY;
  // The PPR arm needs the KG on so kgAllMentionTriples() yields the entity
  // bridges; the graph arm's wikilink substrate is derived from docMeta inside
  // search.ts and needs nothing extra. KG on is harmless for the other arms.
  process.env.ENABLE_KG = wantsGraph ? 'true' : 'false';
  process.env.BITEMPORAL_KG = 'false';
  process.env.AUTO_LINK = 'false';
  process.env.AUTO_SEED_KG = 'false';
  process.env.ENABLE_EMBEDDINGS = wantsEmbeddings ? 'true' : 'false';

  const search = await import('../lib/search.js');
  const embeddings = wantsEmbeddings ? await import('../lib/embeddings.js') : null;
  const kg = wantsGraph ? await import('../lib/knowledge-graph.js') : null;

  try {
    if (kg) kg.initKnowledgeGraph();

    // Index the snapshot once (walks BRAIN_VAULT). Read-only w.r.t. the vault.
    await search.rebuildIndex();

    // Bootstrap the KG mention triples from the indexed docs so the PPR arm's
    // entity router nodes exist. Idempotent (kgAddTriple upserts).
    if (kg) {
      const kgDocs = new Map<
        string,
        { title: string; content: string; collection: string; tags: string[] }
      >();
      for (const [p, meta] of search.getDocMeta()) {
        kgDocs.set(p, {
          title: meta.title,
          content: meta.content,
          collection: meta.collection,
          tags: meta.tags ?? [],
        });
      }
      kg.kgBootstrap(kgDocs);
    }

    // Derive the gold sets from the indexed notes + their resolved wikilinks.
    const notes = buildGoldNotes(search, opts.maxNotes);
    const { selfRetrieval, multiHop } = deriveGoldSets(notes, {
      includeSelfRetrieval: includeSelf,
      includeMultiHop: includeMulti,
    });

    // Scoring closure for one arm over one gold set.
    const scoreArm = async (arm: RealVaultArm, gold: GoldQuery[]): Promise<RealVaultArmReport> => {
      const searchOpts = armSearchOpts(arm, k);
      const perQuery: Array<{ recall: number; reciprocalRank: number; latencyMs: number }> = [];
      for (const g of gold) {
        const t0 = performance.now();
        const results = await search.hybridSearch(g.query, searchOpts);
        const latencyMs = performance.now() - t0;
        const ranked = results.map((r) => r.path);
        const { recall, reciprocalRank } = scoreRanking(ranked, g.relevant, k);
        perQuery.push({ recall, reciprocalRank, latencyMs });
      }
      return aggregateArm(arm, perQuery);
    };

    const selfReports: RealVaultArmReport[] = [];
    const multiReports: RealVaultArmReport[] = [];

    // Measure the lexical arm FIRST, while embeddings are NOT yet loaded, so its
    // fusion genuinely omits the semantic term (searchSemantic no-ops until the
    // model is ready). Then load embeddings and measure semantic/ppr.
    if (arms.includes('lexical')) {
      if (includeSelf) selfReports.push(await scoreArm('lexical', selfRetrieval));
      if (includeMulti && multiHop.length > 0) multiReports.push(await scoreArm('lexical', multiHop));
    }

    if (embeddings) {
      await embeddings.initEmbeddings();
      const docs = new Map<string, { title: string; content: string }>();
      for (const [p, meta] of search.getDocMeta()) {
        docs.set(p, { title: meta.title, content: meta.content });
      }
      await embeddings.buildFullIndex(docs);

      for (const arm of arms) {
        if (arm === 'lexical') continue;
        if (includeSelf) selfReports.push(await scoreArm(arm, selfRetrieval));
        if (includeMulti && multiHop.length > 0) multiReports.push(await scoreArm(arm, multiHop));
      }
    }

    return {
      vaultDir: path.resolve(opts.vaultDir),
      k,
      nNotes: notes.length,
      arms,
      selfRetrieval: selfReports,
      multiHop: multiReports,
    };
  } finally {
    if (kg) {
      try {
        kg.shutdownKG();
      } catch {
        // best-effort; still attempt the temp-dir cleanup.
      }
    }
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Build {@link GoldNote}s from the live index: titles + wikilink neighbours,
 * resolved to indexed paths. Reuses the SAME resolution search.ts uses for the
 * PPR link graph (basename-first-wins) so the multi-hop gold set matches what
 * the graph arm actually walks. Deterministic sampling under `maxNotes` (sort
 * by path, take the first N) keeps runs reproducible.
 */
function buildGoldNotes(
  search: typeof import('../lib/search.js'),
  maxNotes?: number,
): GoldNote[] {
  const docMeta = search.getDocMeta();

  // basename-first-wins resolver, mirroring resolveLinkTargetLocal in search.ts.
  const allFiles = new Set(docMeta.keys());
  const basenameLookup = new Map<string, string>();
  for (const p of docMeta.keys()) {
    const base = p.replace(/\.md$/, '').split('/').pop()!;
    if (!basenameLookup.has(base)) basenameLookup.set(base, p);
  }
  const resolve = (target: string): string | undefined => {
    const cleaned = target.split('#')[0].trim();
    if (!cleaned) return undefined;
    const withMd = cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;
    if (allFiles.has(withMd)) return withMd;
    const found = basenameLookup.get(cleaned.split('/').pop()!);
    if (found) return found;
    const normalized = withMd.replace(/\\/g, '/');
    if (allFiles.has(normalized)) return normalized;
    return undefined;
  };

  let paths = [...docMeta.keys()].sort();
  if (maxNotes !== undefined && maxNotes >= 0) paths = paths.slice(0, maxNotes);

  const notes: GoldNote[] = [];
  for (const p of paths) {
    const meta = docMeta.get(p)!;
    const links: string[] = [];
    for (const target of extractWikilinksLocal(meta.content)) {
      const t = resolve(target);
      if (t) links.push(t);
    }
    notes.push({
      path: p,
      title: meta.title || p.replace(/\.md$/, '').split('/').pop() || p,
      links: [...new Set(links)],
    });
  }
  return notes;
}

/**
 * Extract `[[wikilink]]` targets from note content. Local copy (search.ts's
 * extractWikilinks is module-private and lib/* is owned elsewhere) — kept in
 * lockstep with the `[[target|alias]]` / `[[target#heading]]` forms the vault
 * uses. Alias/heading suffixes are stripped by the resolver.
 */
function extractWikilinksLocal(content: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const inner = m[1].split('|')[0].trim();
    if (inner) out.push(inner);
  }
  return out;
}

/** Render the report as a compact per-arm table (JSON is emitted separately). */
export function formatRealVaultReport(report: RealVaultReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const ms = (n: number) => `${n.toFixed(1)}ms`;
  const lines: string[] = [];
  lines.push('');
  lines.push(
    `Real-vault benchmark  (k=${report.k}, notes=${report.nNotes}, arms=${report.arms.join('/')})`,
  );
  lines.push(`  vault: ${report.vaultDir}`);

  const section = (title: string, rows: RealVaultArmReport[]) => {
    if (rows.length === 0) return;
    lines.push('─'.repeat(64));
    lines.push(`  ${title}`);
    lines.push(
      `  ${'arm'.padEnd(10)} ${'n'.padStart(5)} ${'recall@k'.padStart(9)} ${'MRR'.padStart(7)} ${'avg'.padStart(9)} ${'p95'.padStart(9)}`,
    );
    for (const r of rows) {
      lines.push(
        `  ${r.arm.padEnd(10)} ${String(r.nQueries).padStart(5)} ` +
          `${pct(r.recallAtK).padStart(9)} ${r.mrr.toFixed(3).padStart(7)} ` +
          `${ms(r.avgLatencyMs).padStart(9)} ${ms(r.p95LatencyMs).padStart(9)}`,
      );
    }
  };

  section('self-retrieval  (query = title → self)', report.selfRetrieval);
  section('multi-hop  (query = title → wikilink neighbours)', report.multiHop);
  lines.push('─'.repeat(64));
  lines.push('');
  return lines.join('\n');
}
