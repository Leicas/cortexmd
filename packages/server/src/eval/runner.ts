/**
 * Harness runner: turns a {@link Dataset} into an {@link EvalReport}.
 *
 * Orchestration is decoupled from retrieval by the injectable
 * {@link Retriever}. The DEFAULT retriever drives the REAL cortexmd pipeline
 * against an isolated temp vault (mkdtemp): it writes each event as a memory
 * note, builds the real lexical index (and, opt-in, the real embedding
 * index), then answers each query with the real {@link hybridSearch}. Unit
 * tests inject a deterministic mock so scoring/orchestration is testable
 * WITHOUT loading an embedding model.
 */

import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

import type {
  Dataset,
  Scenario,
  Retriever,
  QueryResult,
  EvalReport,
} from './types.js';
import { scoreQuery, buildReport } from './scoring.js';

export interface RunHarnessOptions {
  /** Top-k cutoff for scoring. */
  k?: number;
  /**
   * Retrieval backend. Omit to use the real cortexmd pipeline over an isolated
   * temp vault (see {@link createRealRetriever}). Inject a mock in tests.
   */
  retriever?: Retriever;
  /**
   * Enable the BITEMPORAL_KG feature for this run (A/B "treatment" arm). When
   * true the real retriever (a) turns on the flag + KG at ingest so
   * supersession detection and note-validity stamping run for each scenario's
   * dated events, and (b) passes each query's point-in-time `ts` as `asOf` so
   * as-of recall filtering engages. When false (the "baseline" arm) the flag
   * stays OFF and no `asOf` is passed, so recall behaves exactly as today.
   * Ignored when an explicit `retriever` (e.g. the unit-test mock) is injected.
   */
  bitemporal?: boolean;
}

/**
 * Parse a JSONL dataset file into a {@link Dataset}. Blank lines and lines
 * starting with `#` or `//` are skipped; malformed lines throw with their
 * line number so bad fixtures fail loudly.
 */
export async function loadDataset(datasetPath: string): Promise<Dataset> {
  const scenarios: Scenario[] = [];
  const rl = createInterface({
    input: createReadStream(datasetPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Malformed JSON on line ${lineNo} of ${datasetPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    scenarios.push(validateScenario(parsed, lineNo, datasetPath));
  }
  return scenarios;
}

/** Minimal structural validation — the schema contract the dataset agent depends on. */
function validateScenario(obj: unknown, lineNo: number, src: string): Scenario {
  const s = obj as Partial<Scenario>;
  const where = `line ${lineNo} of ${src}`;
  if (typeof s.id !== 'string' || !s.id) throw new Error(`Scenario missing string "id" (${where})`);
  if (!Array.isArray(s.events)) throw new Error(`Scenario "${s.id}" missing "events" array (${where})`);
  if (!Array.isArray(s.queries)) throw new Error(`Scenario "${s.id}" missing "queries" array (${where})`);
  for (const e of s.events) {
    if (typeof e.ts !== 'string' || typeof e.content !== 'string') {
      throw new Error(`Scenario "${s.id}" has an event missing ts/content (${where})`);
    }
  }
  for (const q of s.queries) {
    if (typeof q.ts !== 'string' || typeof q.query !== 'string' || !Array.isArray(q.expectContains)) {
      throw new Error(`Scenario "${s.id}" has a query missing ts/query/expectContains (${where})`);
    }
  }
  return {
    id: s.id,
    description: s.description ?? '',
    events: s.events,
    queries: s.queries,
  };
}

/**
 * Run the harness. For each scenario the retriever is asked every query, the
 * texts are graded by the pure scorers, and the per-query results are rolled
 * up into an {@link EvalReport}.
 */
export async function runHarness(dataset: Dataset, opts: RunHarnessOptions = {}): Promise<EvalReport> {
  const k = opts.k ?? 5;
  const retriever: LifecycleRetriever =
    (opts.retriever as LifecycleRetriever | undefined) ??
    (await createRealRetriever(dataset, k, { bitemporal: opts.bitemporal ?? false }));
  try {
    const results: QueryResult[] = [];
    for (const scenario of dataset) {
      // The real retriever ingests per-scenario (see createRealRetriever); it
      // exposes a `beginScenario` hook when it needs to know the boundary.
      if (retriever.beginScenario) await retriever.beginScenario(scenario);
      for (const query of scenario.queries) {
        const items = await retriever({ query: query.query, ts: query.ts, k });
        const texts = items.map((it) => it.text);
        results.push(scoreQuery(scenario, query, texts, k));
      }
    }
    return buildReport(dataset, results, k);
  } finally {
    if (retriever.cleanup) await retriever.cleanup();
  }
}

/**
 * A {@link Retriever} that may also carry lifecycle hooks the harness calls.
 * The mock retriever in tests can ignore these; the real one uses them to
 * ingest each scenario's events and to tear down its temp vault.
 */
export interface LifecycleRetriever {
  /** Retrieve the top-k items for a query at a point in time. */
  (args: { query: string; ts: string; k: number }): ReturnType<Retriever>;
  /** Called before a scenario's queries so the backend can ingest its events. */
  beginScenario?: (scenario: Scenario) => Promise<void>;
  /** Called once after the whole run to release resources (temp vault, etc.). */
  cleanup?: () => Promise<void>;
}

/**
 * Build the REAL retriever: an isolated temp vault + the actual cortexmd
 * memory/search pipeline.
 *
 * CRITICAL ordering: config.ts resolves the brain-vault path and data dirs
 * from env vars AT MODULE-LOAD TIME and freezes them. So we set BRAIN_VAULT /
 * DATA_DIR / EMBEDDINGS_DATA_DIR to fresh temp dirs BEFORE dynamically
 * importing config/vault/search/embeddings. Import them statically at the top
 * and the harness would bind to the developer's real vault — hence the
 * dynamic import here.
 *
 * Embeddings are OPT-IN (EVAL_EMBEDDINGS=1). Lexical-only still exercises the
 * real MiniSearch index + hybridSearch fusion path and gives a fast, valid
 * baseline; enabling embeddings loads the model (~seconds) for full fidelity.
 *
 * BITEMPORAL ARM (`opts.bitemporal`): the treatment side of the A/B. It flips
 * on the real feature end-to-end for this temp vault ONLY — never production:
 *   - BITEMPORAL_KG='true' + ENABLE_KG='true' are set BEFORE the dynamic
 *     imports (mirroring how BRAIN_VAULT etc. are set above) so config.ts
 *     freezes the flag ON and knowledge-graph.ts initializes;
 *   - `runSupersessionForNotes` runs after each scenario's notes are written so
 *     dated events supersede their predecessors + stamp note validity windows;
 *   - the query's point-in-time `ts` is passed to hybridSearch as `asOf`, which
 *     is the ONLY trigger for as-of recall filtering.
 * With `opts.bitemporal` false none of the above happens and the arm is
 * byte-identical to the pre-existing baseline (flag off, no asOf).
 */
export interface RealRetrieverOptions {
  /** Enable the BITEMPORAL_KG treatment arm (see {@link createRealRetriever}). */
  bitemporal?: boolean;
}

export async function createRealRetriever(
  _dataset: Dataset,
  _k: number,
  opts: RealRetrieverOptions = {},
): Promise<LifecycleRetriever> {
  const bitemporal = opts.bitemporal ?? false;
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'cortexmd-eval-'));
  const brainVault = path.join(tmpRoot, 'brain');
  const dataDir = path.join(tmpRoot, 'data');
  const embeddingsDir = path.join(dataDir, 'embeddings');
  await mkdir(brainVault, { recursive: true });
  await mkdir(embeddingsDir, { recursive: true });

  const useEmbeddings = process.env.EVAL_EMBEDDINGS === '1';

  // Point the whole pipeline at the temp vault + disable side effects that
  // would slow ingest or pull in real data. Set BEFORE the dynamic imports.
  process.env.BRAIN_VAULT = brainVault;
  process.env.DATA_DIR = dataDir;
  process.env.EMBEDDINGS_DATA_DIR = embeddingsDir;
  delete process.env.SOURCE_VAULTS;
  delete process.env.VAULT_RO_PERSO;
  delete process.env.VAULT_RO_HAPLY;
  // Bitemporal arm needs the KG on (supersession writes go through KG-core) and
  // the feature flag flipped ON — both read at module-load, so set them here
  // BEFORE the dynamic imports. Baseline arm leaves the flag OFF and the KG off,
  // exactly as the pre-existing harness did.
  process.env.ENABLE_KG = bitemporal ? 'true' : 'false';
  process.env.BITEMPORAL_KG = bitemporal ? 'true' : 'false';
  process.env.AUTO_LINK = 'false';
  process.env.AUTO_SEED_KG = 'false';
  process.env.ENABLE_EMBEDDINGS = useEmbeddings ? 'true' : 'false';

  // Dynamic imports so the env above is honored at their module-load.
  const { writeNote } = await import('../lib/vault.js');
  const { stringifyFrontmatter } = await import('../lib/frontmatter.js');
  const search = await import('../lib/search.js');
  const embeddings = useEmbeddings ? await import('../lib/embeddings.js') : null;

  // Bitemporal-only imports: init the KG so isKgInitialized() passes, and pull
  // the batch supersession pass. Both are no-ops on the baseline arm (not even
  // imported), keeping that path unchanged.
  const kg = bitemporal ? await import('../lib/knowledge-graph.js') : null;
  const bitemp = bitemporal ? await import('../lib/bitemporal.js') : null;
  if (kg) {
    kg.initKnowledgeGraph();
  }

  if (embeddings) {
    await embeddings.initEmbeddings();
  }

  let scenarioSeq = 0;

  const retriever = (async ({ query, ts, k }) => {
    // Bitemporal arm: pass the query's point-in-time `ts` as `asOf` so as-of
    // recall filtering engages (its ONLY trigger). Baseline arm passes no
    // `asOf`, so recall is byte-identical to today.
    const searchOpts = bitemporal
      ? { limit: k, type: 'memory' as const, asOf: ts }
      : { limit: k, type: 'memory' as const };
    const results = await search.hybridSearch(query, searchOpts);
    const docMeta = search.getDocMeta();
    return results.map((r) => {
      const meta = docMeta.get(r.path);
      const body = meta?.content ?? r.snippet ?? '';
      const title = meta?.title ?? r.title ?? '';
      return { text: `${title}\n${body}`, path: r.path, score: r.score };
    });
  }) as LifecycleRetriever;

  retriever.beginScenario = async (scenario: Scenario) => {
    // Namespace each scenario under its own folder so ids can't collide and
    // one scenario's memories never bleed into another's recall.
    scenarioSeq++;
    const prefix = `Memories/eval-${String(scenarioSeq).padStart(3, '0')}-${scenario.id}`;
    // Collect note descriptors for the bitemporal supersession pass. On the
    // baseline arm this array is simply unused.
    const written: Array<{ path: string; frontmatter: Record<string, unknown>; body: string }> = [];
    for (let i = 0; i < scenario.events.length; i++) {
      const ev = scenario.events[i];
      const notePath = `${prefix}/event-${String(i).padStart(3, '0')}.md`;
      const day = ev.ts.slice(0, 10);
      const frontmatter: Record<string, unknown> = {
        id: `${scenario.id}-${i}`,
        type: 'memory',
        category: 'observation',
        title: firstLine(ev.content),
        importance: 'medium',
        temperature: 'warm',
        heat_score: 8,
        created: day,
        last_updated: day,
        last_accessed: day,
        date: day,
      };
      if (ev.tags && ev.tags.length > 0) frontmatter.tags = ev.tags;
      const noteBody = `# ${firstLine(ev.content)}\n\n${ev.content}\n`;
      const noteContent = stringifyFrontmatter(frontmatter, noteBody);
      await writeNote(notePath, noteContent);
      written.push({ path: notePath, frontmatter, body: noteBody });
    }
    // Bitemporal arm: run supersession over this scenario's dated events so
    // single-valued facts (office move, role change, db choice) close their
    // predecessors and stamp the earlier notes' validity windows. It is a
    // no-op unless BITEMPORAL_KG is on AND the KG is initialized (both true on
    // this arm). Ordered by valid_from internally. Never throws.
    if (bitemp) {
      await bitemp.runSupersessionForNotes(written);
    }
    // Rebuild the real lexical index over the freshly written notes. This runs
    // AFTER supersession so DocMeta reflects the stamped valid_to/superseded_by
    // windows the as-of filter reads.
    await search.rebuildIndex();
    // Build the real embedding index over the same docs when enabled.
    if (embeddings) {
      const docs = new Map<string, { title: string; content: string }>();
      for (const [p, meta] of search.getDocMeta()) {
        docs.set(p, { title: meta.title, content: meta.content });
      }
      await embeddings.buildFullIndex(docs);
    }
  };

  retriever.cleanup = async () => {
    // Close the KG's SQLite handle first — on Windows the open WAL/-shm files
    // keep the temp dir locked and `rm` fails with EBUSY otherwise. No-op on
    // the baseline arm (kg was never imported/opened).
    if (kg) {
      try {
        kg.shutdownKG();
      } catch {
        // best-effort; still attempt the rm below.
      }
    }
    await rm(tmpRoot, { recursive: true, force: true });
  };

  return retriever;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'Memory';
  return line.length > 80 ? line.slice(0, 77) + '...' : line;
}

export type { Dataset, EvalReport, QueryResult } from './types.js';

// Re-export loader for a raw file path convenience used by the CLI.
export async function loadDatasetFile(p: string): Promise<Dataset> {
  await readFile(p, 'utf-8').catch(() => {
    throw new Error(`Dataset not found: ${p}`);
  });
  return loadDataset(p);
}
