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

  let apiKey = process.env.API_KEY ?? persisted.apiKey;
  if (!apiKey) {
    apiKey = crypto.randomBytes(32).toString('base64url');
    persisted.apiKey = apiKey;
    dirty = true;
    process.stderr.write(`Generated API key: ${apiKey} (set API_KEY to override)\n`);
  }

  let dashboardPassword = process.env.DASHBOARD_PASSWORD ?? persisted.dashboardPassword;
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
  // Idle-session sweep. Set to 0 to disable (sessions only die on transport close or DELETE).
  sessionTimeoutMs: parseInt(process.env.SESSION_TIMEOUT_MS ?? '0', 10),
  // How long to retain persisted session metadata across restarts (default 30d, matches JWT lifetime).
  sessionRetentionMs: parseInt(process.env.SESSION_RETENTION_MS ?? '2592000000', 10),

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
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
  embeddingsDataDir: process.env.EMBEDDINGS_DATA_DIR ?? '/app/data/embeddings',
  embeddingDimension: 384,
  hnswMaxElements: 100_000,
  hnswEfConstruction: 200,
  hnswM: 16,
  hnswEfSearch: 100,

  // Knowledge graph
  kgEnabled: process.env.ENABLE_KG !== 'false',

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
  //   AUTO_LINK_RELATED_MIN_SCORE=0.02 — fused-score floor for a backlink
  //   AUTO_LINK_RELATED_MAX=3         — max similarity backlinks per note
  //   AUTO_SEED_KG=false              — disable inline KG triple seeding
  autoLink: process.env.AUTO_LINK !== 'false',
  autoLinkMinConfidence: parseFloat(process.env.AUTO_LINK_MIN_CONFIDENCE ?? '0.7'),
  autoLinkRelatedNotes: process.env.AUTO_LINK_RELATED !== 'false',
  autoLinkRelatedMinScore: parseFloat(process.env.AUTO_LINK_RELATED_MIN_SCORE ?? '0.02'),
  autoLinkRelatedMax: parseInt(process.env.AUTO_LINK_RELATED_MAX ?? '3', 10),
  autoSeedKg: process.env.AUTO_SEED_KG !== 'false',

  // Memory engine v2: contradiction detection on memory_store. Toggleable for
  // tests/benchmarks. Default true; embeds the new body + same-entity candidates
  // and surfaces any with cosine ≥ 0.85 and zero shared content tokens.
  memoryContradictionDetect: process.env.MEMORY_CONTRADICTION_DETECT !== 'false',

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

  // Tool profile: tiny | nav | core | lean | full. Trims the registered tool
  // surface so reduced clients pay fewer manifest tokens. Tools outside the
  // profile remain registered (and discoverable via `tool_search`) but are
  // disabled — they don't appear in `tools/list` and cannot be invoked.
  toolProfile: (process.env.OBSIDIAN_TOOL_PROFILE ?? 'full').toLowerCase() as
    | 'tiny' | 'nav' | 'core' | 'lean' | 'full',

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
