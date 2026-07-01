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
    (opts.retriever as LifecycleRetriever | undefined) ?? (await createRealRetriever(dataset, k));
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
 */
export async function createRealRetriever(_dataset: Dataset, _k: number): Promise<LifecycleRetriever> {
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
  process.env.ENABLE_KG = 'false';
  process.env.AUTO_LINK = 'false';
  process.env.AUTO_SEED_KG = 'false';
  process.env.ENABLE_EMBEDDINGS = useEmbeddings ? 'true' : 'false';

  // Dynamic imports so the env above is honored at their module-load.
  const { writeNote } = await import('../lib/vault.js');
  const { stringifyFrontmatter } = await import('../lib/frontmatter.js');
  const search = await import('../lib/search.js');
  const embeddings = useEmbeddings ? await import('../lib/embeddings.js') : null;

  if (embeddings) {
    await embeddings.initEmbeddings();
  }

  let scenarioSeq = 0;

  const retriever = (async ({ query, k }) => {
    const results = await search.hybridSearch(query, { limit: k, type: 'memory' });
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
    }
    // Rebuild the real lexical index over the freshly written notes.
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
