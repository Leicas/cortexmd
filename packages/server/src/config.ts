import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Resolve the default writable "brain" vault directory in a cross-platform way.
 * Windows: %LOCALAPPDATA%\cortexmd\brain (falls back to homedir if unset).
 * Other:   $XDG_DATA_HOME/cortexmd/brain or ~/.local/share/cortexmd/brain.
 */
function defaultBrainVault(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? os.homedir();
    return path.join(base, 'cortexmd', 'brain');
  }
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'cortexmd', 'brain');
}

const brainVault = process.env.BRAIN_VAULT ?? process.env.VAULT_RW ?? defaultBrainVault();
fs.mkdirSync(brainVault, { recursive: true });

/**
 * Locally-managed secrets that are auto-generated on first run when the
 * operator does not supply them via env vars. Persisted to
 * `${brainVault}/Ops/local-secrets.json` (best-effort 0600) and reused across
 * restarts so the simple "no env vars" deployment stays stable.
 */
interface LocalSecrets {
  apiKey?: string;
  dashboardPassword?: string;
}

const LOCAL_SECRETS_PATH = path.join(brainVault, 'Ops', 'local-secrets.json');

function loadLocalSecrets(): LocalSecrets {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_SECRETS_PATH, 'utf-8')) as LocalSecrets;
  } catch {
    return {};
  }
}

function saveLocalSecrets(secrets: LocalSecrets): void {
  try {
    fs.mkdirSync(path.dirname(LOCAL_SECRETS_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        msg: `[local-secrets] failed to persist ${LOCAL_SECRETS_PATH}: ${err instanceof Error ? err.message : String(err)}`,
      }) + '\n',
    );
  }
}

/**
 * Resolve the API key and dashboard password. Precedence per value:
 *   env var  ??  persisted local secret  ??  freshly generated (and persisted).
 * API_KEY is no longer required — when unset we generate one once and print it
 * to stderr so the operator can capture it. Newly-generated values are printed
 * exactly once (on the run that generates them).
 */
function resolveLocalSecrets(): { apiKey: string; dashboardPassword: string } {
  const persisted = loadLocalSecrets();
  let dirty = false;

  // `||` (not `??`): docker-compose passes `API_KEY: "${API_KEY:-}"`, i.e. an
  // EMPTY string when unset. With `??` the empty string won, the persisted value
  // was ignored, and a fresh key + password were generated (and printed) on
  // every boot. Treat an empty env var as unset.
  let apiKey = process.env.API_KEY || persisted.apiKey;
  if (!apiKey) {
    apiKey = crypto.randomBytes(32).toString('base64url');
    persisted.apiKey = apiKey;
    dirty = true;
    process.stderr.write(`Generated API key: ${apiKey} (set API_KEY to override)\n`);
  }

  let dashboardPassword = process.env.DASHBOARD_PASSWORD || persisted.dashboardPassword;
  if (!dashboardPassword) {
    dashboardPassword = crypto.randomBytes(18).toString('base64url');
    persisted.dashboardPassword = dashboardPassword;
    dirty = true;
    process.stderr.write(`Dashboard password: ${dashboardPassword} (set DASHBOARD_PASSWORD to override)\n`);
  }

  if (dirty) saveLocalSecrets(persisted);
  return { apiKey, dashboardPassword };
}

const { apiKey, dashboardPassword } = resolveLocalSecrets();

/**
 * Parse CODE_REPOS env var into a list of {name, absolutePath}.
 * Format: comma-separated entries, each either `name=abs/path` or `abs/path`
 * (in which case basename is used as the name). Whitespace is trimmed.
 */
function parseCodeRepos(raw: string | undefined): ReadonlyArray<{ name: string; absolutePath: string }> {
  if (!raw) return [];
  const out: { name: string; absolutePath: string }[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq > 0) {
      out.push({ name: entry.slice(0, eq).trim(), absolutePath: entry.slice(eq + 1).trim() });
    } else {
      out.push({ name: path.basename(entry), absolutePath: entry });
    }
  }
  return out;
}

// One-time deprecation warning for legacy env var names. Emitted directly to
// stderr because the logger module imports this config (circular dependency).
function warnDeprecatedEnv(oldName: string, newName: string): void {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      msg: `[deprecation] ${oldName} is deprecated; use ${newName} instead. Legacy value still honored for now.`,
    }) + '\n',
  );
}

if (process.env.VAULT_RW) warnDeprecatedEnv('VAULT_RW', 'BRAIN_VAULT');

// Read-only source vault, parsed from a single SOURCE_VAULTS entry.
export interface SourceVault {
  name: string;
  path: string;
  /**
   * Default-deny include-glob allowlist (privacy control). When non-empty,
   * ONLY paths matching one of these globs are walked/indexed/embedded. When
   * empty, the whole vault is indexable (legacy / opt-out behavior).
   */
  includeGlobs: string[];
}

/**
 * Parse a single SOURCE_VAULTS entry. Accepted forms:
 *   name=path
 *   path                       (basename used as the name)
 *   name=path:glob1|glob2      (default-deny include allowlist)
 *   path:glob1|glob2
 *
 * The allowlist is the substring after the LAST ':' — but only when that
 * substring looks glob-like (contains '|', '*', '?', '[' or a '/'), so that a
 * Windows drive letter ("C:\\vault") is not mistaken for a glob separator.
 */
function parseSourceVaultEntry(rawEntry: string): SourceVault {
  let name: string | undefined;
  let rest = rawEntry;
  const eq = rest.indexOf('=');
  if (eq > 0) {
    name = rest.slice(0, eq).trim();
    rest = rest.slice(eq + 1).trim();
  }

  let pathPart = rest;
  let includeGlobs: string[] = [];
  const lastColon = rest.lastIndexOf(':');
  // A leading Windows drive-letter colon ("C:/vault", "D:\notes") is part of
  // the path, not the path:glob separator — don't split on it.
  const isDriveColon = lastColon === 1 && /^[A-Za-z]:/.test(rest);
  if (lastColon > 0 && !isDriveColon) {
    const maybeGlobs = rest.slice(lastColon + 1);
    if (/[|*?\[\/]/.test(maybeGlobs)) {
      pathPart = rest.slice(0, lastColon).trim();
      includeGlobs = maybeGlobs
        .split('|')
        .map((g) => g.trim())
        .filter(Boolean);
    }
  }

  return {
    name: name ?? path.basename(pathPart),
    path: pathPart,
    includeGlobs,
  };
}

// Primary config is SOURCE_VAULTS, a comma-separated list of entries (see
// parseSourceVaultEntry). Legacy VAULT_RO_PERSO / VAULT_RO_HAPLY are still
// honored if set (no allowlist). No defaults.
const sourceVaultConfigs: SourceVault[] = [];
for (const entry of (process.env.SOURCE_VAULTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  sourceVaultConfigs.push(parseSourceVaultEntry(entry));
}
if (process.env.VAULT_RO_PERSO) {
  warnDeprecatedEnv('VAULT_RO_PERSO', 'SOURCE_VAULTS (name=path[:glob|glob],comma-separated)');
  sourceVaultConfigs.push({ name: 'perso', path: process.env.VAULT_RO_PERSO, includeGlobs: [] });
}
if (process.env.VAULT_RO_HAPLY) {
  warnDeprecatedEnv('VAULT_RO_HAPLY', 'SOURCE_VAULTS (name=path[:glob|glob],comma-separated)');
  sourceVaultConfigs.push({ name: 'haply', path: process.env.VAULT_RO_HAPLY, includeGlobs: [] });
}
const sourceVaults: string[] = sourceVaultConfigs.map((s) => s.path);

const MAX_NOTE_SIZE = parseInt(
  process.env.MAX_NOTE_SIZE ?? String(5 * 1024 * 1024),
  10,
);

const MAX_REQUEST_SIZE_BYTES = parseInt(
  process.env.MAX_REQUEST_SIZE_BYTES ?? String(10 * 1024 * 1024),
  10,
);

/**
 * Known embedding models: output dimension, pooling and the query/document
 * prefixes the model was trained with. EMBEDDING_MODEL picks a row; any other
 * model id works too — set EMBEDDING_DIMENSION / EMBEDDING_POOLING /
 * EMBEDDING_QUERY_PREFIX / EMBEDDING_DOC_PREFIX explicitly (the dimension is
 * also auto-detected from the model's first output).
 */
export type EmbeddingPooling = 'mean' | 'cls' | 'last_token' | 'sentence_embedding';
export interface EmbeddingModelPreset {
  dimension: number;
  pooling: EmbeddingPooling;
  queryPrefix: string;
  docPrefix: string;
  /**
   * Cosine below which a hit carries no semantic evidence — the default of
   * FUSION_SEMANTIC_FLOOR. Model-specific: E5 cosines live in ~0.75–0.92, so
   * the MiniLM floor (0.15) would flatten its scores to a near-constant.
   */
  semanticFloor?: number;
}
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_MODEL_PRESETS: Record<string, EmbeddingModelPreset> = {
  'Xenova/all-MiniLM-L6-v2': { dimension: 384, pooling: 'mean', queryPrefix: '', docPrefix: '' },
  'Xenova/multilingual-e5-small': { dimension: 384, pooling: 'mean', queryPrefix: 'query: ', docPrefix: 'passage: ', semanticFloor: 0.75 },
  'Xenova/multilingual-e5-base': { dimension: 768, pooling: 'mean', queryPrefix: 'query: ', docPrefix: 'passage: ', semanticFloor: 0.75 },
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': { dimension: 384, pooling: 'mean', queryPrefix: '', docPrefix: '' },
  'onnx-community/embeddinggemma-300m-ONNX': {
    dimension: 768, pooling: 'sentence_embedding',
    queryPrefix: 'task: search result | query: ', docPrefix: 'title: none | text: ',
  },
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': {
    dimension: 1024, pooling: 'last_token',
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:', docPrefix: '',
  },
};
const embeddingModelId = process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
const embeddingPreset: EmbeddingModelPreset =
  EMBEDDING_MODEL_PRESETS[embeddingModelId] ?? { dimension: 384, pooling: 'mean', queryPrefix: '', docPrefix: '' };
function envInt(name: string, fallback: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  port: parseInt(process.env.API_PORT ?? '3000', 10),
  apiKey,
  // Password for the local server-managed dashboard login (Component A). Falls
  // back to a persisted/generated value when DASHBOARD_PASSWORD is unset.
  dashboardPassword,
  brainVault,
  sourceVaults,
  sourceVaultConfigs,
  allVaults: [brainVault, ...sourceVaults],
  deniedSegments: ['.obsidian', '.sync', '.trash'],
  corsOrigins: process.env.CORS_ORIGINS ?? '*',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  indexRebuildIntervalMs: parseInt(process.env.INDEX_REBUILD_INTERVAL_MS ?? '60000', 10),
  maxRequestSize: process.env.MAX_REQUEST_SIZE ?? '10mb',
  maxRequestSizeBytes: MAX_REQUEST_SIZE_BYTES,
  maxNoteSize: MAX_NOTE_SIZE,
  maxPathLength: 1024,
  // Idle-session sweep (default 30 min). Set to 0 to disable (sessions then only
  // die on transport close, DELETE, or LRU eviction). Clients that never DELETE
  // (n8n workflow runs, the CLI) otherwise accumulate transports forever.
  sessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS ?? '1800000', 10),
  // Hard cap on live MCP sessions. When a new session would exceed it, the
  // least-recently-active session is closed first. 0 disables the cap.
  maxActiveSessions: parseInt(process.env.MAX_ACTIVE_SESSIONS ?? '200', 10),
  // How long to retain persisted session metadata across restarts (default 7d).
  sessionRetentionMs: parseInt(process.env.SESSION_RETENTION_MS ?? '604800000', 10),
  // Max session records written to sessions.json (newest lastActivity kept).
  maxPersistedSessions: parseInt(process.env.MAX_PERSISTED_SESSIONS ?? '500', 10),

  // OAuth public URL (issuer / redirect base).
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',

  // Forward-auth (OPTIONAL). When PROXY_AUTH=true the server trusts a
  // Remote-User header set by an upstream reverse proxy (e.g. Authelia/Traefik
  // forward-auth) on admin/dashboard routes and the OAuth /authorize endpoint.
  // This is an advanced/team deployment knob — it is OFF by default. With it
  // off (the OSS default) those routes fall back to plain API-key auth and the
  // /authorize flow attributes the grant to PROXY_AUTH_USER ("local" by
  // default). Plain API key and OAuth work without any forward-auth proxy.
  proxyAuth: process.env.PROXY_AUTH === 'true',
  proxyAuthUser: process.env.PROXY_AUTH_USER || 'local',

  // Persistent data directory (JWT secret, OAuth clients, etc.)
  dataDir: process.env.DATA_DIR ?? '/app/data',

  // ── Lexical index backend (lib/lexical-sqlite.ts, docs/ARCHITECTURE.md §6) ──
  // ONLY 'minisearch' (in-RAM MiniSearch index + note bodies in docMeta) is
  // active today. 'sqlite' (on-disk SQLite/FTS5) and 'shadow' (MiniSearch
  // answers, SQLite runs alongside for rank-overlap logging) are RESERVED for
  // the follow-up rollout documented in ARCHITECTURE.md §6: the backend
  // exists and is tested, but search.ts does not use it yet. Setting either
  // value logs one warning at boot (searchBackendRequested) and the server
  // keeps running on MiniSearch.
  searchBackend: 'minisearch' as 'minisearch' | 'sqlite' | 'shadow',
  searchBackendRequested: (process.env.SEARCH_BACKEND ?? 'minisearch').trim().toLowerCase() || 'minisearch',
  // Derived, deletable cache; rebuilt automatically on schema/analyzer change.
  // Keep it on a LOCAL disk: SQLite WAL needs shared memory (no NFS/SMB).
  lexicalDbPath: process.env.LEXICAL_DB_PATH
    || path.join(process.env.DATA_DIR ?? '/app/data', 'lexical.sqlite'),
  // Max synchronous slice of a sync (ms) — the event-loop block bound.
  lexicalSyncSliceMs: parseInt(process.env.LEXICAL_SYNC_SLICE_MS ?? '25', 10),
  // Body KiB indexed per note (the rest is stored but not searchable).
  lexicalMaxIndexedKb: parseInt(process.env.LEXICAL_MAX_INDEXED_KB ?? '256', 10),

  // Build identity, injected by CI at image build time (see Dockerfile +
  // release.yml). 'dev' locally. Surfaced via /health so the deployed release
  // is verifiable without inspecting the container.
  appVersion: process.env.APP_VERSION ?? 'dev',
  gitSha: process.env.GIT_SHA ?? 'unknown',

  // Source-vault refresh (git-pull transport). How often a
  // GitPullVault source is re-pulled (fast-forward only) so re-indexing sees
  // upstream changes. Default 5 minutes; set to 0 to disable periodic refresh.
  sourceRefreshIntervalMs: parseInt(process.env.SOURCE_REFRESH_INTERVAL_MS ?? '300000', 10),

  // How often to flush metrics to disk (default: 5 minutes)
  metricsFlushIntervalMs: parseInt(process.env.METRICS_FLUSH_INTERVAL_MS ?? '300000', 10),

  // Idle-edge dream: fire a lightweight consolidation pass once the server has
  // been quiet (no tool calls / captures) for idleDreamMs. Opt-in via
  // IDLE_DREAM=on, independent of the nightly DREAM_SCHEDULE cron. Cross-platform
  // (pure wall-clock, no OS idle probing). Default idle threshold 5 min; the
  // poller checks every idleDreamCheckMs.
  idleDreamEnabled: (process.env.IDLE_DREAM ?? 'off').toLowerCase() === 'on',
  idleDreamMs: parseInt(process.env.IDLE_DREAM_MS ?? '300000', 10),
  idleDreamCheckMs: parseInt(process.env.IDLE_DREAM_CHECK_MS ?? '60000', 10),
  idleDreamBudgetMs: parseInt(process.env.IDLE_DREAM_BUDGET_MS ?? '30000', 10),

  // Embeddings / semantic search
  enableEmbeddings: process.env.ENABLE_EMBEDDINGS !== 'false',
  // Model id + how to drive it. Changing the model or dimension never mixes
  // vectors: each (model, dimension) pair persists to its own index file and a
  // switch triggers a clean background re-embed (see lib/embeddings.ts).
  embeddingModel: embeddingModelId,
  embeddingsDataDir: process.env.EMBEDDINGS_DATA_DIR ?? '/app/data/embeddings',
  embeddingDimension: envInt('EMBEDDING_DIMENSION', embeddingPreset.dimension),
  embeddingPooling: ((process.env.EMBEDDING_POOLING as EmbeddingPooling | undefined) || embeddingPreset.pooling) as EmbeddingPooling,
  embeddingQueryPrefix: process.env.EMBEDDING_QUERY_PREFIX ?? embeddingPreset.queryPrefix,
  embeddingDocPrefix: process.env.EMBEDDING_DOC_PREFIX ?? embeddingPreset.docPrefix,
  // ONNX weight variant (transformers.js dtype): q8 (default, 8-bit), fp32, fp16, q4…
  embeddingDtype: process.env.EMBEDDING_DTYPE || 'q8',
  // Chars of a text fed to the model (≈ the 256-token window of the default).
  embeddingMaxChars: envInt('EMBEDDING_MAX_CHARS', 1280),
  // Texts per forward pass when embedding documents in bulk. 1 is the
  // measured optimum on CPU with q8 weights (batches of 8/16 were ~25-35%
  // slower per chunk and doubled RSS); raise it only for GPU/WebGPU backends.
  embeddingBatchSize: envInt('EMBEDDING_BATCH_SIZE', 1),
  // ONNX intra-op threads for the embedding model (0 = onnxruntime default:
  // all cores). Cap it on a shared host so a background re-embed (model
  // switch, chunk migration) cannot starve request handling.
  embeddingThreads: parseInt(process.env.EMBEDDING_THREADS ?? '0', 10) || 0,
  // Chunk-level vectors: long notes get a lead vector plus ~200-token
  // heading-aware section vectors (lib/chunking.ts); note score = best chunk.
  // EMBEDDING_CHUNKING=off restores one vector per note.
  embeddingChunking: (process.env.EMBEDDING_CHUNKING ?? 'on').toLowerCase() !== 'off',
  embeddingChunkChars: envInt('EMBEDDING_CHUNK_CHARS', 800),
  embeddingChunkOverlap: parseInt(process.env.EMBEDDING_CHUNK_OVERLAP ?? '120', 10) || 0,
  embeddingMaxChunks: envInt('EMBEDDING_MAX_CHUNKS', 24),
  // Note-level score from chunk hits: 'max' (best chunk) or 'top2' (mean of the two best).
  embeddingChunkRollup: ((process.env.EMBEDDING_CHUNK_ROLLUP ?? 'max').toLowerCase() === 'top2' ? 'top2' : 'max') as 'max' | 'top2',
  hnswMaxElements: 100_000,
  hnswEfConstruction: 200,
  hnswM: 16,
  hnswEfSearch: 100,
  // HNSW compaction: every update markDeletes the old vector and adds a new
  // label, so dead slots accumulate. Rebuild the graph from the live stored
  // vectors (in the background, chunked) once dead slots exceed this ratio of
  // live vectors AND at least HNSW_COMPACT_MIN_DELETED of them exist.
  hnswCompactRatio: parseFloat(process.env.HNSW_COMPACT_RATIO ?? '0.25'),
  hnswCompactMinDeleted: parseInt(process.env.HNSW_COMPACT_MIN_DELETED ?? '256', 10),
  // Background re-embedding of notes changed outside the server (rescan) —
  // notes per batch, and the pause between batches so a bulk sync (Syncthing
  // dropping 1000 files) never monopolises the event loop.
  embedSyncBatch: parseInt(process.env.EMBED_SYNC_BATCH ?? '32', 10),
  embedSyncPauseMs: parseInt(process.env.EMBED_SYNC_PAUSE_MS ?? '250', 10),

  // Index build: files read in parallel (results are applied in listing order).
  indexReadConcurrency: parseInt(process.env.INDEX_READ_CONCURRENCY ?? '16', 10),
  // The server listens before the boot index build finishes; a tool call that
  // arrives meanwhile waits up to this long, then fails with an "indexing" error.
  indexReadyWaitMs: parseInt(process.env.INDEX_READY_WAIT_MS ?? '20000', 10),
  // Heap usage (% of the V8 heap limit) above which /health flags `heap.warn`
  // and a warning is logged (re-armed once usage drops 5 points below).
  heapWarnPct: parseFloat(process.env.HEAP_WARN_PCT ?? '80'),

  // Scheduled brain-vault backup (OFF by default). BACKUP_SCHEDULE=on (daily
  // 03:30) or a "M H * * *" cron. Archives are timestamped .tar.gz files in
  // BACKUP_DIR (default <DATA_DIR>/backups); the newest BACKUP_KEEP are kept.
  // Restore: docs/deploy-http.md "Backup and restore".
  backupSchedule: (process.env.BACKUP_SCHEDULE ?? 'off').trim(),
  backupDir: process.env.BACKUP_DIR ?? '',
  backupKeep: parseInt(process.env.BACKUP_KEEP ?? '7', 10),

  // Knowledge graph
  kgEnabled: process.env.ENABLE_KG !== 'false',

  // Bitemporal knowledge graph (v1). DORMANT by default — note the inverted
  // default vs. the sibling flags above (those default ON via `!== 'false'`;
  // this one defaults OFF via `=== 'true'`). When ON, ingestion runs
  // supersession detection + stamps source-note validity windows. As-of recall
  // filtering is a SEPARATE, independent gate — it triggers only when an `asOf`
  // argument is passed to recall, regardless of this flag. With the flag off and
  // no `asOf`, both ingestion and recall behave exactly as they do today.
  bitemporalKg: process.env.BITEMPORAL_KG === 'true',

  // Personalized-PageRank graph-recall arm (HippoRAG-2 style). DORMANT by
  // default — inverted default like `bitemporalKg` (defaults OFF via
  // `=== 'true'`). When ON (or when a per-call `opts.graph === true` is passed
  // to hybridSearch), an ADDITIVE third RRF arm runs PPR over a unified
  // note/entity graph and fuses its rank contribution alongside lexical +
  // semantic. Because it only ADDS RRF mass, enabling it can re-rank or
  // introduce results but never drop an existing lexical/semantic hit. With
  // this flag off AND no `opts.graph`, hybridSearch is byte-identical to today
  // (the graph arm block is skipped entirely — no graph build, no PPR).
  pprRecall: process.env.PPR_RECALL === 'true',
  // Cosine threshold above which two notes get a synonymy edge in the recall
  // graph (only when embeddings are ready). Bounded per-note kNN keeps it
  // O(N·fanout), never O(N²).
  pprSynonymyThreshold: parseFloat(process.env.PPR_SYNONYMY_THRESHOLD ?? '0.8'),

  // ── Recall retrieval/ranking (lib/search.ts hybridSearch, lib/memory.ts) ──
  // Bilingual lexical analyzer (accent folding, EN+FR stopwords, light plural
  // stemming, length-gated fuzzy/prefix). LEXICAL_ANALYZER=legacy restores the
  // raw MiniSearch tokenizer (prefix + fuzzy 0.2 on every term).
  lexicalAnalyzer: (process.env.LEXICAL_ANALYZER ?? 'bilingual').toLowerCase() !== 'legacy',
  // kNN candidates fetched from the vector index per query. The index holds
  // every note type, so a small k starves filtered searches (type:memory).
  semanticCandidates: parseInt(process.env.SEMANTIC_CANDIDATES ?? '200', 10),
  // Lexical candidates kept per query before fusion (score fusion only).
  lexicalCandidates: parseInt(process.env.LEXICAL_CANDIDATES ?? '100', 10),
  // Fusion of the retrieval arms. 'score' (default): weighted sum of each
  // arm's normalised score — BM25 relative to the best lexical hit, cosine
  // above a floor — so a strong semantic-only hit can outrank a weak lexical
  // one and score gaps survive into re-scoring. HYBRID_FUSION=rrf restores
  // reciprocal-rank fusion (k=60, equal arms).
  hybridFusion: ((process.env.HYBRID_FUSION ?? 'score').toLowerCase() === 'rrf' ? 'rrf' : 'score') as 'score' | 'rrf',
  fusionLexicalWeight: parseFloat(process.env.FUSION_LEXICAL_WEIGHT ?? '0.5'),
  fusionSemanticWeight: parseFloat(process.env.FUSION_SEMANTIC_WEIGHT ?? '0.5'),
  // Default comes from the embedding model's preset (0.15 for MiniLM).
  fusionSemanticFloor: parseFloat(process.env.FUSION_SEMANTIC_FLOOR ?? String(embeddingPreset.semanticFloor ?? 0.15)),
  // Weight of the PPR graph arm under score fusion (only when PPR_RECALL=true
  // or a per-call opts.graph). Capped below the direct arms: graph proximity
  // is supporting evidence, never stronger than a direct match.
  pprWeight: parseFloat(process.env.PPR_WEIGHT ?? '0.1'),

  // Recall re-scoring (lib/memory.ts rescoreRecall). 'bounded' (default):
  // normalised relevance × (1 + prior), where the combined prior (importance,
  // category, heat, recency, centrality, co-recall) is clamped to
  // ±recallPriorBound, so priors break ties instead of overriding relevance.
  // RECALL_SCORING=legacy restores the unbounded multiplicative boosts.
  recallScoring: ((process.env.RECALL_SCORING ?? 'bounded').toLowerCase() === 'legacy' ? 'legacy' : 'bounded') as 'bounded' | 'legacy',
  recallPriorBound: parseFloat(process.env.RECALL_PRIOR_BOUND ?? '0.08'),
  // Score multiplier for the low-priority tier (consolidation digests, email
  // captures) unless the query asks for them. 1 disables the demotion.
  recallLowTierPenalty: parseFloat(process.env.RECALL_LOW_TIER_PENALTY ?? '0.5'),
  // MMR relevance/novelty trade-off for the final selection (1 = no diversity).
  recallMmrLambda: parseFloat(process.env.RECALL_MMR_LAMBDA ?? '0.85'),
  // Minimum-evidence floor (abstention). Rank-relative scores cannot tell the
  // best of a bad lot from a real match, so recall looks at two absolute
  // signals over the candidates: the best hit's BM25 per unit of query IDF
  // mass ("lexical evidence") and the best cosine similarity. When BOTH are
  // under their floor the query is treated as unanswerable and recall returns
  // nothing; between the floor and recallLowConfidenceEvidence the results are
  // returned but flagged low-confidence. RECALL_MIN_EVIDENCE=off disables.
  recallMinEvidence: (process.env.RECALL_MIN_EVIDENCE ?? 'on').toLowerCase() !== 'off',
  recallMinLexicalEvidence: parseFloat(process.env.RECALL_MIN_LEXICAL_EVIDENCE ?? '2.5'),
  recallMinSimilarity: parseFloat(process.env.RECALL_MIN_SIMILARITY ?? '0.55'),
  recallLowConfidenceEvidence: parseFloat(process.env.RECALL_LOW_CONFIDENCE_EVIDENCE ?? '6'),
  // memory_recall candidate pool. 'durable' (default): type:memory notes plus
  // durable non-memory notes the memory-kind classifier calls semantic or
  // procedural (project notes, references, CRM entities, runbooks…) at a
  // lower weight; structural / machine-made kinds (indexes, tasks, templates,
  // code projections) and non-memory episodic notes (diary days, journals,
  // EmailLog captures, email digests) stay out. RECALL_SCOPE=memory restores
  // the memory-only pool (type:memory + type:digest). On the real-vault eval
  // 'durable' is +5 pt Recall@5 at equal noise and abstention (see
  // docs/BENCHMARKS.md).
  recallScope: ((process.env.RECALL_SCOPE ?? 'durable').toLowerCase() === 'memory' ? 'memory' : 'durable') as 'memory' | 'durable',
  // Episodic notes (lib/memory-kind.ts: digests, email captures, hook / n8n
  // exhaust, diaries, conversation logs) under memory_recall's default
  // semantic + procedural scope. 'demote' (default): still searched, but as
  // the low-priority tier — digests and email captures × recallLowTierPenalty,
  // other episodic notes × recallEpisodicPenalty — unless the caller opts in
  // (kinds / includeEpisodic) or the query asks for them by name.
  // RECALL_EPISODIC=exclude: never returned unless opted in / asked for
  // (−2.7 pt Recall@5 on the real-vault eval, see docs/BENCHMARKS.md).
  recallEpisodic: ((process.env.RECALL_EPISODIC ?? 'demote').toLowerCase() === 'exclude' ? 'exclude' : 'demote') as 'demote' | 'exclude',
  recallEpisodicPenalty: parseFloat(process.env.RECALL_EPISODIC_PENALTY ?? '1'),
  // Time-aware queries (lib/time-query.ts): "last week", "en octobre",
  // "as of March" become date filters, "latest" a mild recency preference.
  // RECALL_TIME_QUERY=off disables the parsing (explicit dateFrom/dateTo/asOf
  // parameters always work).
  recallTimeQuery: (process.env.RECALL_TIME_QUERY ?? 'on').toLowerCase() !== 'off',
  // Days added on each side of a period PARSED from the query (never to
  // explicit parameters): notes are stamped in UTC, "yesterday" is local time.
  recallTimeSlackDays: parseInt(process.env.RECALL_TIME_SLACK_DAYS ?? '1', 10) || 0,

  // Automatic linking on store (memory_store / notes_upsert). Conservative +
  // reversible defaults: entity links keep the historical 0.7 confidence gate;
  // similarity backlinks use a higher score floor than the advisory
  // `findSimilarNotes` surface and land in a clearly-marked, strippable
  // `## Related (auto)` section + `auto_related` frontmatter (curated `related`
  // is never overwritten). KG triples are seeded inline so the temporal graph
  // grows on every write instead of only on manual bootstrap/backfill.
  //   AUTO_LINK=false                 — master kill switch for all of the below
  //   AUTO_LINK_MIN_CONFIDENCE=0.7    — entity auto-link confidence gate
  //   AUTO_LINK_RELATED=false         — disable similarity backlinks only
  //   AUTO_LINK_RELATED_MIN_SCORE=0.03 — fused-score floor for a backlink. RRF
  //                                     with k=60: 0.03 ≈ both arms agree in
  //                                     their top ~5 (0.02 let any single-arm
  //                                     top hit through → links to digests).
  //   AUTO_LINK_RELATED_MAX=2         — max similarity backlinks per note (hard cap 5)
  //   AUTO_SEED_KG=false              — disable inline KG triple seeding
  //   AUTO_SEED_KG_CATEGORIES=decision,fact,insight,preference,plan
  //                                   — only notes of these categories seed
  //                                     mentions_* / co_mentioned triples;
  //                                     email + machine auto-captures never do
  autoLink: process.env.AUTO_LINK !== 'false',
  autoLinkMinConfidence: parseFloat(process.env.AUTO_LINK_MIN_CONFIDENCE ?? '0.7'),
  autoLinkRelatedNotes: process.env.AUTO_LINK_RELATED !== 'false',
  autoLinkRelatedMinScore: parseFloat(process.env.AUTO_LINK_RELATED_MIN_SCORE ?? '0.03'),
  autoLinkRelatedMax: Math.min(5, parseInt(process.env.AUTO_LINK_RELATED_MAX ?? '2', 10)),
  autoSeedKg: process.env.AUTO_SEED_KG !== 'false',
  autoSeedKgCategories: (process.env.AUTO_SEED_KG_CATEGORIES ?? 'decision,fact,insight,preference,plan')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Born-cold ingest. A capture whose `source` matches one of these regexes
  // (case-insensitive, `|||`-separated) is MACHINE exhaust — n8n triage, email,
  // PostToolUse/UserPromptSubmit hooks — and is stored `temperature: cold`,
  // `importance: low`, `heat_score: 0`; it earns heat only through recall.
  // Deliberate captures (any other source) keep the warm/6 start.
  // Built-in defaults live in lib/vault-hygiene/patterns.ts
  // (DEFAULT_MACHINE_SOURCE_PATTERNS); setting the env var REPLACES them.
  //   MACHINE_CAPTURE_SOURCES='^n8n|||^hook'   — override the defaults
  machineCaptureSourcePatterns: (process.env.MACHINE_CAPTURE_SOURCES ?? '')
    .split('|||')
    .map((s) => s.trim())
    .filter(Boolean),
  // Recurring-briefing dedup: a machine capture whose normalised title stem +
  // source match a note created in the last N days supersedes that note
  // instead of piling up a near-duplicate per day. 0 disables.
  recurringCaptureWindowDays: parseInt(process.env.RECURRING_CAPTURE_WINDOW_DAYS ?? '7', 10),

  // Capture-time noise filter (memory_store + /api/store-memory). Drops
  // memories whose title is a raw shell-command stub or an automated email
  // (see lib/capture-filter.ts for the built-in patterns: label/bare shell
  // command echoes, tool-result fragments, multi-line `git commit:` echoes,
  // prompt fragments from UserPromptSubmit captures).
  //   CAPTURE_NOISE_FILTER=false      — disable the filter entirely
  //   CAPTURE_NOISE_PATTERNS='re1|||re2' — extra title regexes, `|||`-separated
  captureNoiseFilter: process.env.CAPTURE_NOISE_FILTER !== 'false',
  captureNoisePatterns: (process.env.CAPTURE_NOISE_PATTERNS ?? '')
    .split('|||')
    .map((s) => s.trim())
    .filter(Boolean),

  // Memory engine v2: contradiction detection on memory_store. Toggleable for
  // tests/benchmarks. Default true; embeds the new body + same-entity candidates
  // and surfaces any with cosine ≥ 0.85 and zero shared content tokens.
  memoryContradictionDetect: process.env.MEMORY_CONTRADICTION_DETECT !== 'false',

  // Asynchronous LLM reconcile on write (lib/reconcile.ts). OFF by default.
  // When the write-path heuristics (contradiction / title-conflict) flag a
  // (new note, existing note) pair, a background worker asks a small Claude
  // model for a strict verdict ADD | UPDATE | SUPERSEDE | DUPLICATE | NOOP and
  // applies it NON-destructively via frontmatter links (supersedes /
  // superseded_by / valid_to, updates / updated_by, duplicate_of). Requires
  // ANTHROPIC_API_KEY. Dry-run (log verdicts to the audit file only) is the
  // default even once enabled — set RECONCILE_DRY_RUN=false to apply.
  //   RECONCILE_LLM=true              — enable the queue + worker
  //   RECONCILE_DRY_RUN=true          — only audit verdicts (default true)
  //   RECONCILE_MODEL=claude-haiku-5-5
  //   RECONCILE_MIN_CONFIDENCE=0.8    — never act below this model confidence
  //   RECONCILE_MAX_QUEUE=100         — bounded queue (overflow is dropped + audited)
  //   RECONCILE_RATE_PER_MIN=10       — model calls per minute
  //   RECONCILE_DAILY_BUDGET=200      — model calls per UTC day (0 = none)
  //   RECONCILE_MAX_RETRIES=3         — transport retries, exponential backoff
  //   RECONCILE_TIMEOUT_MS=20000      — per-call timeout
  // Audit log: <DATA_DIR>/reconcile-audit.jsonl (one JSON verdict per line).
  reconcileEnabled: process.env.RECONCILE_LLM === 'true',
  reconcileDryRun: process.env.RECONCILE_DRY_RUN !== 'false',
  reconcileModel: process.env.RECONCILE_MODEL || 'claude-haiku-5-5',
  reconcileMinConfidence: parseFloat(process.env.RECONCILE_MIN_CONFIDENCE ?? '0.8'),
  reconcileMaxQueue: parseInt(process.env.RECONCILE_MAX_QUEUE ?? '100', 10),
  reconcileRatePerMin: parseFloat(process.env.RECONCILE_RATE_PER_MIN ?? '10'),
  reconcileDailyBudget: parseInt(process.env.RECONCILE_DAILY_BUDGET ?? '200', 10),
  reconcileMaxRetries: parseInt(process.env.RECONCILE_MAX_RETRIES ?? '3', 10),
  reconcileTimeoutMs: parseInt(process.env.RECONCILE_TIMEOUT_MS ?? '20000', 10),

  // Bayesian validity tracking on memories. Default on; set to 'false' to
  // disable both update-on-recall/contradiction and the quarantine/stale
  // filters in memory_recall.
  memoryValidity: process.env.MEMORY_VALIDITY !== 'false',

  // Graph-centrality recall signal. memory_recall multiplies each result by
  // (1 + weight × normalizedInboundLinks), so a well-connected note (many
  // inbound [[wikilinks]]) ranks above an otherwise-equal orphan. Conservative
  // default; set RECALL_CENTRALITY_WEIGHT=0 to disable (ranking unchanged).
  recallCentralityWeight: parseFloat(process.env.RECALL_CENTRALITY_WEIGHT ?? '0.15'),

  // Co-recall associative memory (Hebbian / HippoRAG-style). memory_recall
  // accumulates a decaying association graph from which memories are recalled
  // together, then boosts candidates strongly associated with the current top
  // results (spreading activation: boost = 1 + weight × associationStrength).
  // The vault's own usage history teaches it which memories belong together.
  //   CO_RECALL=false        — disable recording + spreading activation
  //   CO_RECALL_WEIGHT=0.2   — spreading-activation boost weight (0 disables boost only)
  coRecallEnabled: process.env.CO_RECALL !== 'false',
  coRecallWeight: parseFloat(process.env.CO_RECALL_WEIGHT ?? '0.2'),

  // Tool profile: standard (default) | chatgpt | tiny | nav | core | lean | full.
  // Only trims what `tools/list` advertises (fewer manifest tokens per
  // session). Tools outside the profile stay registered and enabled: they are
  // discoverable via `tool_search` and invocable via the advertised
  // `tool_invoke(name, arguments)` dispatcher (or a direct tools/call from a
  // raw MCP client). TOOL_PROFILE=full advertises everything (pre-1.21
  // behaviour). OBSIDIAN_TOOL_PROFILE is the legacy name, still honoured.
  // Parsed/validated by lib/tool-profile.ts parseToolProfile().
  toolProfile: (process.env.TOOL_PROFILE || process.env.OBSIDIAN_TOOL_PROFILE || 'standard').toLowerCase().trim(),

  // ChatGPT connector `search`/`fetch` tools (src/tools/search-fetch.ts).
  // Registered + advertised under TOOL_PROFILE=chatgpt, or under any profile
  // when CHATGPT_SEARCH_FETCH=true.
  chatgptSearchFetch: process.env.CHATGPT_SEARCH_FETCH === 'true' || process.env.CHATGPT_SEARCH_FETCH === '1',

  // Bench / benchmark knobs (token-savior parity). All default off.
  // - hookMinimal: hooks emit only the smallest required output, skipping
  //   advisory / hint payloads.
  // - noHints: tool responses skip the trailing "💡 hint" sentences that
  //   nudge agents toward cheaper alternatives.
  // - memoryDisable: hooks skip injecting recalled memory blocks. Used for
  //   ablation in benchmarking.
  hookMinimal: process.env.OBSIDIAN_HOOK_MINIMAL === '1' || process.env.OBSIDIAN_HOOK_MINIMAL === 'true',
  noHints: process.env.OBSIDIAN_NO_HINTS === '1' || process.env.OBSIDIAN_NO_HINTS === 'true',
  memoryDisable: process.env.OBSIDIAN_MEMORY_DISABLE === '1' || process.env.OBSIDIAN_MEMORY_DISABLE === 'true',

  // Reranker (supports Anthropic or OpenAI-compatible backends like llama.cpp)
  enableReranker: process.env.ENABLE_RERANKER === 'true',
  rerankerProvider: (process.env.RERANKER_PROVIDER ?? '') as '' | 'anthropic' | 'openai-compatible',
  rerankerBaseUrl: process.env.RERANKER_BASE_URL ?? '',
  rerankerModel: process.env.RERANKER_MODEL ?? '',
  rerankerApiKey: process.env.RERANKER_API_KEY ?? '',
  rerankerTimeoutMs: parseInt(process.env.RERANKER_TIMEOUT_MS ?? '1500', 10),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',

  // Local cross-encoder reranker (lib/cross-encoder.ts) — transformers.js ONNX,
  // CPU, lazy-loaded on first use. Off by default; independent of the LLM
  // reranker above.
  enableCrossEncoder: process.env.ENABLE_CROSS_ENCODER === 'true',
  crossEncoderModel: process.env.CROSS_ENCODER_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2',
  crossEncoderDtype: process.env.CROSS_ENCODER_DTYPE || 'q8',
  crossEncoderTopK: envInt('CROSS_ENCODER_TOP_K', 30),
  crossEncoderBatchSize: envInt('CROSS_ENCODER_BATCH_SIZE', 8),
  crossEncoderMaxChars: envInt('CROSS_ENCODER_MAX_CHARS', 1200),
  crossEncoderTimeoutMs: envInt('CROSS_ENCODER_TIMEOUT_MS', 800),

  // Optional bounded investigators. Separate from reranking; never infer credentials or a model.
  workerEnabled: process.env.WORKER_ENABLED === 'true',
  workerProvider: process.env.WORKER_PROVIDER ?? '',
  workerEndpoint: process.env.WORKER_ENDPOINT ?? '',
  workerModel: process.env.WORKER_MODEL ?? '',
  workerApiKey: process.env.WORKER_API_KEY ?? '',
  workerMaxConcurrency: Number(process.env.WORKER_MAX_CONCURRENCY ?? '2'),
  workerMaxToolCalls: Number(process.env.WORKER_MAX_TOOL_CALLS ?? '12'),
  workerMaxRounds: Number(process.env.WORKER_MAX_ROUNDS ?? '8'),
  workerMaxInputTokens: Number(process.env.WORKER_MAX_INPUT_TOKENS ?? '100000'),
  workerMaxOutputTokens: Number(process.env.WORKER_MAX_OUTPUT_TOKENS ?? '4000'),
  workerMaxToolResultBytes: Number(process.env.WORKER_MAX_TOOL_RESULT_BYTES ?? '16000'),
  workerTimeoutMs: Number(process.env.WORKER_TIMEOUT_MS ?? '90000'),

  // Memory stack identity file
  identityFile: process.env.IDENTITY_FILE ?? '',

  // Code-nav (per-machine code symbol index).
  // CODE_REPOS is now bootstrap-only — repos register themselves into the
  // local DB via code_repo_register, mirrored to ${BRAIN_VAULT}/Ops/code-repos.json.
  codeRepos: parseCodeRepos(process.env.CODE_REPOS),
  machineId: process.env.MACHINE_ID || os.hostname(),
  codeAutoProjectOnRecall: process.env.CODE_AUTO_PROJECT_ON_RECALL === 'true',
  codeNavLangs: (process.env.CODE_NAV_LANGS || 'ts,tsx,js,jsx,py,rs,go')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const;
