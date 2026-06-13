import crypto from 'node:crypto';
import { readdir, access, stat } from 'node:fs/promises';
import { constants as fsConstants, realpathSync } from 'node:fs';
import nodePath from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { initEmbeddings, persistIndex as persistEmbeddingIndex, isEmbeddingsReady, buildFullIndex, syncIndexIncremental, wasPersistedIndexLoaded } from './lib/embeddings.js';
import { config } from './config.js';
import { apiKeyMiddleware, dashboardAuthMiddleware, SESSION_COOKIE_NAME } from './auth.js';
import { mintDashboardSession } from './oauth.js';
import { rebuildIndex, getIndexedNoteCount, getDocMeta, getVaultHealth, reindexSourceVaults, getIndexHealth } from './lib/search.js';
import {
  onSourceVaultsChanged,
  listSourceVaults,
  addSourceVault,
  removeSourceVault,
  SourceVaultError,
} from './lib/source-vaults.js';
import { writeBinaryFile } from './lib/vault.js';
import { consumeUploadToken } from './lib/upload-tokens.js';
import { buildAndCacheGraph, getGraphStats } from './lib/graph.js';
import { logger } from './lib/logger.js';
import {
  getMetrics,
  recordCategorizedRequest,
  recordErrorResponse,
  setActiveSessionsCount,
  startMetricsSampling,
  stopMetricsSampling,
  initMetricsFromDisk,
  persistMetricsToDisk,
  registerTemperatureSampler,
  registerVaultHealthSampler,
  registerLinkDensitySampler,
  registerCodeNavSampler,
} from './lib/metrics.js';
import { saveSessions, loadSessions } from './lib/persistence.js';
import type { PersistedSession } from './lib/persistence.js';
import { cleanupExpired, checkRateLimit } from './lib/rate-limit.js';
import type { RequestCategory } from './lib/metrics.js';
import { dashboardRouter } from './dashboard/index.js';
import { oauthRouter } from './oauth.js';

// Tool registration imports
import { register as registerNotesSearch } from './tools/notes-search.js';
import { register as registerToolSearch } from './tools/tool-search.js';
import { snapshotTools, buildToolEmbeddings } from './lib/tool-meta.js';
import { applyToolProfile, parseToolProfile } from './lib/tool-profile.js';
import { register as registerNotesGet } from './tools/notes-get.js';
import { register as registerGraphNeighbors } from './tools/graph-neighbors.js';
import { register as registerNotesUpsert } from './tools/notes-upsert.js';
import { register as registerNotesLinkEntities } from './tools/notes-link-entities.js';
import { register as registerJournalAppend } from './tools/journal-append.js';
import { register as registerArtifactIngest } from './tools/artifact-ingest.js';
import { register as registerTasksCreate } from './tools/tasks-create.js';
import { register as registerTasksResolve } from './tools/tasks-resolve.js';
import { register as registerBriefDaily } from './tools/brief-daily.js';
import { register as registerMemoryTemperature } from './tools/memory-temperature.js';
import { register as registerMemoryConsolidate } from './tools/memory-consolidate.js';
import { register as registerNotesArchive } from './tools/notes-archive.js';
import { register as registerMemoryStore } from './tools/memory-store.js';
import { register as registerMemoryRecall } from './tools/memory-recall.js';
import { register as registerNotesList } from './tools/notes-list.js';
import { register as registerTagsList } from './tools/tags-list.js';
import { register as registerArtifactUploadToken } from './tools/artifact-upload-token.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { setSessionToolHook } from './lib/tool-wrapper.js';
import { initKnowledgeGraph, shutdownKG, isKgInitialized } from './lib/knowledge-graph.js';
import { normalizeConversation, autoDetectFormat } from './lib/conversation-normalizer.js';
import { extractMemories } from './lib/memory-extractor.js';
import { runQualityBenchmark } from './lib/benchmark.js';
import { runDreamCycle } from './lib/dream-engine.js';
import { appendJournalEntry } from './lib/journal.js';
import { forceFullRebuild } from './lib/search.js';
import { kgRepair } from './lib/knowledge-graph.js';

// New tool imports (parity plan)
import { register as registerKgAdd } from './tools/kg-add.js';
import { register as registerKgQuery } from './tools/kg-query.js';
import { register as registerKgTimeline } from './tools/kg-timeline.js';
import { register as registerKgInvalidate } from './tools/kg-invalidate.js';
import { register as registerCheckDuplicate } from './tools/check-duplicate.js';
import { register as registerConversationsMine } from './tools/conversations-mine.js';
import { register as registerEntityDetect } from './tools/entity-detect.js';
import { register as registerEntityRebuild } from './tools/entity-rebuild.js';
import { register as registerMemoryWakeup } from './tools/memory-wakeup.js';
import { register as registerGraphTraverse } from './tools/graph-traverse.js';
import { register as registerDiaryWrite } from './tools/diary-write.js';
import { register as registerDiaryRead } from './tools/diary-read.js';
import { register as registerAgentDiaryAppend } from './tools/agent-diary-append.js';
import { register as registerAgentDiaryRead } from './tools/agent-diary-read.js';
import { register as registerBenchmarkRun } from './tools/benchmark-run.js';
import { register as registerIndexRepair } from './tools/index-repair.js';
import { register as registerGraphStats } from './tools/graph-stats.js';
import { register as registerKgStats } from './tools/kg-stats.js';
import { register as registerVaultStatus } from './tools/vault-status.js';
import { register as registerVaultTaxonomy } from './tools/vault-taxonomy.js';
import { register as registerNotesDelete } from './tools/notes-delete.js';
import { register as registerMemoryDream } from './tools/memory-dream.js';
import { register as registerMemoryPromote } from './tools/memory-promote.js';
import { register as registerReasoningSave } from './tools/reasoning-save.js';
import { register as registerReasoningSearch } from './tools/reasoning-search.js';

// AGENT-A new tool registrations
import { register as registerMemoryConsolidateSeries } from './tools/memory-consolidate-series.js';
// END AGENT-A new tool registrations

// AGENT-B new tool registrations
import { register as registerNotesCategorize } from './tools/notes-categorize.js';
// END AGENT-B new tool registrations

// AGENT-C new tool registrations
import { register as registerGraphOrphans } from './tools/graph-orphans.js';
import { register as registerGraphBrokenLinks } from './tools/graph-broken-links.js';
import { register as registerTagsHygiene } from './tools/tags-hygiene.js';
import { registerJob, stopAllJobs } from './lib/scheduler.js';
import { refreshSourceVaults, sourceVaultTransports } from './lib/vault/registry.js';
import { decayMemories, autoArchiveColdMemories } from './lib/memory-lifecycle.js';
// END AGENT-C new tool registrations

// Agents / Teams registry tools
import { register as registerAgentsList } from './tools/agents-list.js';
import { register as registerAgentsGet } from './tools/agents-get.js';
import { register as registerTeamsList } from './tools/teams-list.js';
import { register as registerTeamsGet } from './tools/teams-get.js';
import { register as registerTeamDispatch } from './tools/team-dispatch.js';
import { register as registerSkillsList } from './tools/skills-list.js';
import { register as registerSkillsGet } from './tools/skills-get.js';

// Code-nav tools (phase 1 + Wave 1 + Wave 2)
import {
  registerCodeIndexRepo,
  registerCodeIngestRepo,
  registerCodeSyncPull,
  registerCodeSavingsPush,
  registerCodeReposSync,
  registerCodeSymbolSearch,
  registerCodeSymbolGet,
  registerCodeSymbolCallers,
  registerCodeSymbolCallees,
  registerCodeFileOutline,
  registerCodeRepoRegister,
  registerCodeRepoList,
  registerCodeRepoScan,
  registerCodeRepoRename,
  registerCodeRepoDrop,
  registerCodeProjectSymbol,
  registerCodeCheckStaleness,
  registerCodeChangeImpact,
  registerCodeCallChain,
  registerCodeFullContext,
  registerCodeAuditFile,
  registerCodeNavStats,
  registerCodeFindImportCycles,
  registerCodeFindDeadCode,
  registerCodeFindSemanticDuplicates,
  registerCodeDetectBreakingChanges,
} from './tools/code-nav.js';
import { loadVaultRegistryIntoDb, getCodeDb } from './lib/code-nav/db.js';
import { readVaultRegistry } from './lib/code-nav/registry.js';
import { probeGit } from './lib/code-nav/repos.js';
import { getCodeNavStats } from './lib/code-nav/stats.js';

const allRegistrations = [
  registerNotesSearch,
  registerNotesGet,
  registerGraphNeighbors,
  registerNotesUpsert,
  registerNotesLinkEntities,
  registerJournalAppend,
  registerArtifactIngest,
  registerTasksCreate,
  registerTasksResolve,
  registerBriefDaily,
  registerMemoryTemperature,
  registerMemoryConsolidate,
  registerNotesArchive,
  registerMemoryStore,
  registerMemoryRecall,
  registerNotesList,
  registerTagsList,
  registerArtifactUploadToken,
  // Parity plan tools
  registerKgAdd,
  registerKgQuery,
  registerKgTimeline,
  registerKgInvalidate,
  registerCheckDuplicate,
  registerConversationsMine,
  registerEntityDetect,
  registerMemoryWakeup,
  registerGraphTraverse,
  registerDiaryWrite,
  registerDiaryRead,
  registerAgentDiaryAppend,
  registerAgentDiaryRead,
  registerBenchmarkRun,
  registerIndexRepair,
  registerGraphStats,
  registerKgStats,
  registerEntityRebuild,
  registerVaultStatus,
  registerVaultTaxonomy,
  registerNotesDelete,
  registerMemoryDream,
  registerMemoryPromote,
  // Reasoning traces (token-savior parity, Slice 7)
  registerReasoningSave,
  registerReasoningSearch,
  // AGENT-A new tool registrations
  registerMemoryConsolidateSeries,
  // END AGENT-A new tool registrations
  // AGENT-B new tool registrations
  registerNotesCategorize,
  // END AGENT-B new tool registrations
  // AGENT-C new tool registrations
  registerGraphOrphans,
  registerGraphBrokenLinks,
  registerTagsHygiene,
  // END AGENT-C new tool registrations
  // Agents / Teams registry tools
  registerAgentsList,
  registerAgentsGet,
  registerTeamsList,
  registerTeamsGet,
  registerTeamDispatch,
  registerSkillsList,
  registerSkillsGet,
  // Code-nav tools (phase 1 + Wave 1 + Wave 2)
  registerCodeIndexRepo,
  registerCodeIngestRepo,
  registerCodeSyncPull,
  registerCodeSavingsPush,
  registerCodeReposSync,
  registerCodeSymbolSearch,
  registerCodeSymbolGet,
  registerCodeSymbolCallers,
  registerCodeSymbolCallees,
  registerCodeFileOutline,
  // Wave 1 — repo management
  registerCodeRepoRegister,
  registerCodeRepoList,
  registerCodeRepoScan,
  registerCodeRepoRename,
  registerCodeRepoDrop,
  // Wave 2 — projection + staleness
  registerCodeProjectSymbol,
  registerCodeCheckStaleness,
  // Wave 3 — change-impact + call-chain (forward direction)
  registerCodeChangeImpact,
  registerCodeCallChain,
  // Wave 4 — token-savior parity (full_context + audit_file)
  registerCodeFullContext,
  registerCodeAuditFile,
  // Code-nav stats / token savings surface
  registerCodeNavStats,
  // Wave 5 — structural detectors (token-savior parity)
  registerCodeFindImportCycles,
  registerCodeFindDeadCode,
  registerCodeFindSemanticDuplicates,
  registerCodeDetectBreakingChanges,
  // Defer-loading meta-tool (token-savior parity, Slice 1)
  registerToolSearch,
];

function createServer(): McpServer {
  const server = new McpServer({
    name: 'cortexmd',
    version: '1.0.0',
  });

  for (const register of allRegistrations) {
    register(server);
  }

  // Register MCP resources and prompts
  registerResources(server);
  registerPrompts(server);

  // Snapshot the full tool registry BEFORE profile filtering so `tool_search`
  // can still discover disabled tools. Then apply the profile to disable
  // anything outside the requested set.
  snapshotTools(server);
  applyToolProfile(server, parseToolProfile(config.toolProfile));

  return server;
}

// Map of session ID -> { transport, lastActivity, ... }
interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  createdAt: number;
  requestCount: number;
  clientInfo?: { sub?: string; clientId?: string };
  ip?: string;
  toolCounts: Record<string, number>;
  lastTools: string[];  // last 5 tool names used
}
const sessions = new Map<string, SessionEntry>();
const MAX_SESSION_LAST_TOOLS = 5;

// Persisted session metadata for sessions that survived a restart.
// When a client reconnects with a known session ID, we restore this metadata.
const persistedSessionMeta = new Map<string, PersistedSession>();

/**
 * Serialize active sessions (and not-yet-reconnected persisted sessions) for disk persistence.
 */
function getSessionsForPersistence(): PersistedSession[] {
  const result: PersistedSession[] = [];
  for (const [sid, entry] of sessions) {
    result.push({
      sessionId: sid,
      createdAt: entry.createdAt,
      lastActivity: entry.lastActivity,
      requestCount: entry.requestCount,
      clientInfo: entry.clientInfo,
      ip: entry.ip,
      toolCounts: { ...entry.toolCounts },
      lastTools: [...entry.lastTools],
    });
  }
  // Also include persisted sessions that haven't reconnected yet
  for (const [, meta] of persistedSessionMeta) {
    result.push(meta);
  }
  return result;
}

function updateSessionActivity(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.lastActivity = Date.now();
    entry.requestCount++;
  }
}

/**
 * Record a tool call against a session for dashboard visibility.
 */
function recordSessionToolCall(sessionId: string, toolName: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  entry.toolCounts[toolName] = (entry.toolCounts[toolName] ?? 0) + 1;
  entry.lastTools.push(toolName);
  if (entry.lastTools.length > MAX_SESSION_LAST_TOOLS) entry.lastTools.shift();
}

// Wire up the session-level tool tracking hook (avoids circular deps)
setSessionToolHook(recordSessionToolCall);

export interface SessionSnapshot {
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  requestCount: number;
  clientInfo?: object;
  ip?: string;
  toolCounts: Record<string, number>;
  lastTools: string[];
}

/**
 * Return a snapshot of all active sessions (no transport references).
 */
export function getSessionSnapshots(): SessionSnapshot[] {
  const result: SessionSnapshot[] = [];
  for (const [sid, entry] of sessions) {
    result.push({
      sessionId: sid,
      createdAt: entry.createdAt,
      lastActivity: entry.lastActivity,
      requestCount: entry.requestCount,
      clientInfo: entry.clientInfo,
      ip: entry.ip,
      toolCounts: { ...entry.toolCounts },
      lastTools: [...entry.lastTools],
    });
  }
  return result;
}

/**
 * Kill a session by ID: close the transport and remove from the map.
 */
export function killSession(sessionId: string): boolean {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  try {
    entry.transport.close?.();
  } catch {
    // ignore close errors
  }
  sessions.delete(sessionId);
  setActiveSessionsCount(sessions.size);
  return true;
}

const app = express();
app.use(express.json({ limit: config.maxRequestSize }));
app.use(express.urlencoded({ extended: false }));

// CORS middleware
app.use((_req: Request, res: Response, next: NextFunction) => {
  const origins = config.corsOrigins;
  res.setHeader('Access-Control-Allow-Origin', origins);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, mcp-session-id');
  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Security headers
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// X-Request-Id + request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;

    // Classify request by path
    let category: RequestCategory;
    const p = req.path;
    if (p === '/health') {
      category = 'health';
    } else if (p === '/mcp') {
      category = 'mcp';
    } else if (p === '/register' || p === '/authorize' || p === '/token' || p.startsWith('/.well-known/')) {
      category = 'oauth';
    } else if (p.startsWith('/dashboard') || p.startsWith('/metrics') || p === '/debug') {
      category = 'dashboard';
    } else {
      category = 'other';
    }

    recordCategorizedRequest(category);

    if (res.statusCode >= 400) {
      recordErrorResponse();
    }

    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      requestId,
    });
  });

  next();
});

// OAuth endpoints (/.well-known/*, /register, /authorize, /token)
// /authorize is protected by Authelia via Traefik; others are open.
app.use(oauthRouter);

// Health check (no auth)
app.get('/health', (_req, res) => {
  const metrics = getMetrics();
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: metrics.uptime,
    activeSessions: sessions.size,
    indexedNotes: getIndexedNoteCount(),
  });
});

// ── Dashboard login (Component A) — server-managed password + session cookie.
// PUBLIC routes (no auth). On success we mint a short-lived signed JWT and
// store it in an httpOnly, SameSite=Lax cookie; dashboardAuthMiddleware then
// authorizes subsequent dashboard/admin requests.

/** Render the minimal login form. `error` shows a red banner when set. */
function renderLoginPage(error?: string): string {
  const banner = error
    ? `<p style="color:#c0392b;margin:0 0 1rem">${error}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cortexmd — Sign in</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e6e6e6;
         display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  form { background: #1a1d24; padding: 2rem; border-radius: 10px; width: 320px;
         box-shadow: 0 8px 30px rgba(0,0,0,.4); }
  h1 { font-size: 1.25rem; margin: 0 0 1.25rem; }
  label { display: block; font-size: .8rem; margin: 0 0 .35rem; color: #9aa0aa; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border-radius: 6px;
          border: 1px solid #313640; background: #0f1115; color: #e6e6e6; font-size: 1rem; }
  button { margin-top: 1.25rem; width: 100%; padding: .65rem; border: 0; border-radius: 6px;
           background: #4c8bf5; color: #fff; font-size: 1rem; cursor: pointer; }
  button:hover { background: #3a78e0; }
</style>
</head>
<body>
<form method="POST" action="/login">
  <h1>cortexmd dashboard</h1>
  ${banner}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autofocus autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
</body>
</html>
`;
}

/** Constant-time string compare (length-independent). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  // timingSafeEqual requires equal-length buffers; hash to a fixed length so a
  // length mismatch doesn't leak via an early return.
  const ah = crypto.createHash('sha256').update(ab).digest();
  const bh = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

app.get('/login', (_req: Request, res: Response) => {
  res.type('html').send(renderLoginPage());
});

app.post('/login', async (req: Request, res: Response) => {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) ?? 'unknown';

  // Rate-limit login attempts: 10 per 5 minutes per IP.
  const rl = checkRateLimit(`login:${ip}`, 10, 5 * 60 * 1000);
  if (!rl.allowed) {
    res.status(429).type('html').send(renderLoginPage('Too many attempts — try again later.'));
    return;
  }

  const password = (req.body?.password as string | undefined) ?? '';
  if (!password || !constantTimeEqual(password, config.dashboardPassword)) {
    logger.warn('Dashboard login failed', { ip });
    res.status(401).type('html').send(renderLoginPage('Incorrect password.'));
    return;
  }

  const token = await mintDashboardSession();
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: req.secure,
  });
  res.redirect(302, '/dashboard');
});

app.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.redirect(302, '/login');
});

// File upload endpoint (API key auth)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxNoteSize } });
const uploadAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Accept either API key or single-use upload token
  const uploadToken = req.headers['x-upload-token'] as string | undefined;
  if (uploadToken && consumeUploadToken(uploadToken)) {
    next();
    return;
  }
  // Fall back to API key auth
  apiKeyMiddleware(req, res, next);
};

app.post('/upload', uploadAuthMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided. Send as multipart/form-data with field name "file"' });
      return;
    }
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const ext = (req.file.originalname.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    const kind = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(ext) ? 'image'
      : /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(ext) ? 'audio'
      : 'file';
    const safeName = req.file.originalname.replace(/[\\/:*?"<>|]/g, '-');
    const vaultPath = (req.body?.path as string) || `Assets/${kind}/${dateStr}/${safeName}`;

    const base64 = req.file.buffer.toString('base64');
    await writeBinaryFile(vaultPath, base64);

    res.json({ path: vaultPath, size: req.file.size, kind });
  } catch (err: any) {
    logger.error('Upload failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hud-stats — single-shot HUD-line payload for the rtk hud-line
// daemon. Returns a stable JSON shape so the Rust client can render an ≤80-char
// statusline without doing N HTTP roundtrips. API-key auth (no Authelia gate).
app.get('/api/hud-stats', apiKeyMiddleware, async (_req, res) => {
  try {
    const m = getMetrics();
    const dm = getDocMeta();

    // Tool count: enabled tools in the registry (post-profile filtering).
    let mcpToolEnabled = 0;
    let mcpToolTotal = 0;
    try {
      const toolMeta = await import('./lib/tool-meta.js');
      mcpToolTotal = toolMeta.getToolsMeta().length;
    } catch { /* ignore */ }
    try {
      const tp = await import('./lib/tool-profile.js');
      const profile = tp.parseToolProfile(config.toolProfile as string);
      const allowed = tp.profileMembership(profile);
      mcpToolEnabled = allowed ? allowed.size : mcpToolTotal;
    } catch {
      mcpToolEnabled = mcpToolTotal;
    }

    let hot = 0, warm = 0, cold = 0;
    for (const [, meta] of dm) {
      if (meta.temperature === 'hot') hot++;
      else if (meta.temperature === 'warm') warm++;
      else if (meta.temperature === 'cold') cold++;
    }

    // Aggregate p95 across tool calls
    function p95(latencies: number[]): number {
      if (latencies.length === 0) return 0;
      const sorted = [...latencies].sort((a, b) => a - b);
      const idx = Math.ceil(sorted.length * 0.95) - 1;
      return sorted[Math.max(0, idx)];
    }
    let allLatencies: number[] = [];
    for (const [, tc] of Object.entries(m.toolCalls)) {
      allLatencies = allLatencies.concat(tc.latencies);
    }
    const aggregateP95Ms = p95(allLatencies);

    const tokensSaved = m.codeNavSavings?.totalSaved ?? 0;
    const codeNavCalls = m.codeNavSavings?.totalCalls ?? 0;

    res.json({
      tokensSaved,
      codeNavCalls,
      mcpToolEnabled,
      mcpToolTotal,
      memoryTemperature: { hot, warm, cold },
      aggregateP95Ms,
      uptimeSec: Math.round(m.uptime / 1000),
      profile: (config.toolProfile as string) ?? 'full',
    });
  } catch (err: any) {
    logger.error('api/hud-stats failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recall — lightweight context-injection endpoint for hooks.
// Single round-trip (no MCP session handshake) so PreToolUse / UserPromptSubmit
// hooks can stay sub-second. Returns up to N memories + N notes with the same
// hybridSearch ranking memory_recall uses.
app.post('/api/recall', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      query?: string;
      limit?: number;
      kinds?: 'memory' | 'notes' | 'both';
      excludeArchived?: boolean;
    };
    const query = (body.query ?? '').trim();
    if (!query) {
      res.status(400).json({ error: 'query required' });
      return;
    }
    const limit = Math.max(1, Math.min(10, body.limit ?? 5));
    const kinds = body.kinds ?? 'both';
    const excludeArchived = body.excludeArchived ?? true;

    const { hybridSearch } = await import('./lib/search.js');
    const results = await hybridSearch(query, { limit: limit * 3, excludeArchived });

    const memories: Array<{
      path: string; title: string; snippet: string;
      category?: string; temperature?: string; score: number;
    }> = [];
    const notes: Array<{ path: string; title: string; snippet: string; score: number }> = [];

    const dm = getDocMeta();
    for (const r of results) {
      const meta = dm.get(r.path);
      const isMemory = meta?.type === 'memory';
      const entry = {
        path: r.path,
        title: r.title,
        snippet: r.snippet.slice(0, 200),
        score: Math.round(r.score * 10000) / 10000,
      };
      if (isMemory) {
        if (kinds === 'notes') continue;
        if (memories.length >= limit) continue;
        memories.push({
          ...entry,
          category: meta?.category,
          temperature: meta?.temperature,
        });
      } else {
        if (kinds === 'memory') continue;
        if (notes.length >= limit) continue;
        notes.push(entry);
      }
    }

    res.json({ query, memories, notes });
  } catch (err: any) {
    logger.error('api/recall failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/store-memory — lightweight memory append for hook-driven capture.
// Skips the heavy memory_store path (no preference extraction, no entity
// detection, no contradiction probe) so the PostToolUse hook stays fast.
// Use the full memory_store tool for agent-driven captures.
app.post('/api/store-memory', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      content?: string;
      category?: string;
      title?: string;
      tags?: string[];
      source?: string;
    };
    const content = (body.content ?? '').trim();
    if (!content) {
      res.status(400).json({ error: 'content required' });
      return;
    }
    const category = body.category ?? 'observation';
    const allowed = new Set([
      'observation', 'decision', 'insight', 'conversation',
      'fact', 'preference', 'plan', 'reflection',
    ]);
    if (!allowed.has(category)) {
      res.status(400).json({ error: `invalid category: ${category}` });
      return;
    }

    const { writeNote } = await import('./lib/vault.js');
    const { stringifyFrontmatter } = await import('./lib/frontmatter.js');
    const { indexNote } = await import('./lib/search.js');
    const { v4: uuidv4 } = await import('uuid');

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const TIMELESS = new Set(['fact', 'preference']);
    const subdir = TIMELESS.has(category) ? '' : `${year}/${month}/`;

    const firstLine = content.split('\n')[0].trim();
    const title = (body.title ?? firstLine).slice(0, 80) || 'Auto-captured';
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const notePath = `Memories/${category}/${subdir}${today}-${slug}.md`;

    const tags = Array.from(new Set([...(body.tags ?? []), 'auto-capture', `source:${body.source ?? 'hook'}`]));

    const frontmatter: Record<string, unknown> = {
      id: uuidv4(),
      type: 'memory',
      category,
      title,
      importance: 'low',
      temperature: 'warm',
      heat_score: 6,
      access_count: 1,
      last_accessed: today,
      created: today,
      last_updated: today,
      tags,
      source: body.source ?? 'hook',
    };
    const noteBody = `# ${title}\n\n${content}\n`;
    const noteContent = stringifyFrontmatter(frontmatter, noteBody);
    await writeNote(notePath, noteContent);
    try { await indexNote(notePath); } catch { /* best-effort */ }

    res.json({ stored: true, path: notePath, category });
  } catch (err: any) {
    logger.error('api/store-memory failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notes-get — REST shim for the `notes_get` MCP tool. Returns the
// raw markdown plus parsed frontmatter for a vault note. Returns 404 if the
// note doesn't exist (callers can interpret as "no state yet").
app.post('/api/notes-get', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body as { path?: string };
    const rawPath = (body.path ?? '').trim();
    if (!rawPath) {
      res.status(400).json({ error: 'path required' });
      return;
    }

    const { readNote } = await import('./lib/vault.js');
    const { parseFrontmatter } = await import('./lib/frontmatter.js');
    const { sanitizePath } = await import('./lib/sanitize.js');

    const notePath = sanitizePath(rawPath);
    let content: string;
    try {
      const result = await readNote(notePath);
      content = result.content;
    } catch (err: any) {
      // ENOENT or similar → 404 so callers can fall back to defaults
      if (err.code === 'ENOENT' || /not found|no such/i.test(err.message || '')) {
        res.status(404).json({ error: 'not_found', path: notePath });
        return;
      }
      throw err;
    }
    const { data, body: noteBody } = parseFrontmatter(content);
    res.json({ path: notePath, content, frontmatter: data, body: noteBody });
  } catch (err: any) {
    logger.error('api/notes-get failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notes-upsert — REST shim for the `notes_upsert` MCP tool. Limited
// to mergeMode: 'replace' for now (what the n8n email-classifier workflow
// needs). For append/section-merge modes use the full MCP tool.
app.post('/api/notes-upsert', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      path?: string;
      content?: string;
      mergeMode?: 'replace';
      ifMatch?: string;
    };
    const rawPath = (body.path ?? '').trim();
    const rawContent = (body.content ?? '').trim();
    if (!rawPath) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    if (!rawContent) {
      res.status(400).json({ error: 'content required' });
      return;
    }
    const mode = body.mergeMode ?? 'replace';
    if (mode !== 'replace') {
      res.status(400).json({ error: `mergeMode '${mode}' not supported on REST shim — use the notes_upsert MCP tool for append/section modes` });
      return;
    }

    const { writeNote } = await import('./lib/vault.js');
    const { parseFrontmatter, stringifyFrontmatter, ensureId } = await import('./lib/frontmatter.js');
    const { indexNote } = await import('./lib/search.js');
    const { sanitizePath, sanitizeContent } = await import('./lib/sanitize.js');

    const notePath = sanitizePath(rawPath);
    const noteContent = sanitizeContent(rawContent);
    const { data, body: noteBody } = parseFrontmatter(noteContent);
    ensureId(data);
    if (!data.last_updated) data.last_updated = new Date().toISOString().slice(0, 10);
    const finalContent = stringifyFrontmatter(data, noteBody);
    await writeNote(notePath, finalContent, body.ifMatch);
    try { await indexNote(notePath); } catch { /* best-effort */ }

    res.json({ updated: true, path: notePath });
  } catch (err: any) {
    logger.error('api/notes-upsert failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notes-delete — REST shim for the `notes_delete` MCP tool.
// Permanently removes a note from the RW vault and drops it from the search
// index. Used for scripted server-side cleanup (e.g. de-duping after a vault
// reorganization). Idempotent: returns 200 even when the file is already gone.
app.post('/api/notes-delete', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body as { path?: string };
    const rawPath = (body.path ?? '').trim();
    if (!rawPath) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const { deleteNote } = await import('./lib/vault.js');
    const { removeFromIndex } = await import('./lib/search.js');
    const { sanitizePath } = await import('./lib/sanitize.js');

    const notePath = sanitizePath(rawPath);
    try {
      await deleteNote(notePath);
    } catch (err: any) {
      if (err.code === 'ENOENT' || /not found|no such/i.test(err.message || '')) {
        res.json({ deleted: false, alreadyGone: true, path: notePath });
        return;
      }
      throw err;
    }
    try { removeFromIndex(notePath); } catch { /* best-effort */ }
    res.json({ deleted: true, path: notePath });
  } catch (err: any) {
    logger.error('api/notes-delete failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/code-repo-list — minimal repo list for hook-driven cwd→repo lookup.
// Returns just what hooks need: { machineId, repos: [{ slug, paths: [{abs_path}] }] }.
// Skips per-repo SQL counts so it's much cheaper than the full code_repo_list MCP tool.
app.post('/api/code-repo-list', apiKeyMiddleware, async (_req: Request, res: Response) => {
  try {
    const { getCodeDb } = await import('./lib/code-nav/db.js');
    const { getMachineId } = await import('./lib/code-nav/repos.js');
    const db = getCodeDb();
    const machineId = getMachineId();
    const rows = db
      .prepare(
        `SELECT r.slug, p.abs_path
           FROM repos r
           JOIN repo_paths p ON p.repo_id = r.id
          ORDER BY r.slug, p.last_seen_at DESC`,
      )
      .all() as Array<{ slug: string; abs_path: string }>;
    const bySlug = new Map<string, { slug: string; paths: Array<{ abs_path: string }> }>();
    for (const r of rows) {
      const e = bySlug.get(r.slug) ?? { slug: r.slug, paths: [] };
      e.paths.push({ abs_path: r.abs_path });
      bySlug.set(r.slug, e);
    }
    res.json({ machineId, repos: Array.from(bySlug.values()) });
  } catch (err: any) {
    logger.error('api/code-repo-list failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Code-nav REST endpoints (parity with the MCP tools, callable from the
//    Rust indexer / hooks without spinning an MCP session). All API-key auth.
//    Logic mirrors the MCP-tool implementations in src/tools/code-nav.ts.

app.post('/api/code-symbol-search', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const { getCodeDb } = await import('./lib/code-nav/db.js');
    const { resolveRepoBySlug } = await import('./lib/code-nav/repos.js');
    const { recordCodeNavSavings, estimateTokens } = await import('./lib/code-nav/savings.js');
    const body = req.body as { query?: string; kind?: string; repo?: string; limit?: number };
    const rawQuery = (body.query ?? '').toString();
    const kind = body.kind;
    const repoSlug = body.repo;
    const limit = Math.max(1, Math.min(100, Math.floor(body.limit ?? 20)));

    const db = getCodeDb();
    const escaped = rawQuery.replace(/"/g, '""').trim();
    const ftsQuery = escaped.length > 0 ? `"${escaped}"*` : '""';
    const filters: string[] = [];
    const args: any[] = [ftsQuery];
    if (kind) {
      filters.push('s.kind = ?');
      args.push(kind);
    }
    if (repoSlug) {
      const repo = resolveRepoBySlug(repoSlug);
      if (!repo) {
        res.status(404).json({ error: `Unknown repo slug: ${repoSlug}` });
        return;
      }
      filters.push('s.repo_id = ?');
      args.push(repo.id);
    }
    const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
    const sql = `
      SELECT s.id, s.repo_id, s.relative_path, s.name, s.kind, s.qualified_name,
             s.signature, s.start_line, s.end_line, bm25(symbols_fts) AS bm,
             r.slug AS repo_slug
        FROM symbols_fts
        JOIN symbols s ON s.rowid = symbols_fts.rowid
        JOIN repos r ON r.id = s.repo_id
       WHERE symbols_fts MATCH ? ${where}
       ORDER BY bm ASC
       LIMIT ?
    `;
    args.push(limit);
    const rows = db.prepare(sql).all(...args) as any[];
    const results = rows.map((r) => ({
      id: r.id,
      repo: r.repo_slug,
      path: r.relative_path,
      name: r.name,
      kind: r.kind,
      qualifiedName: r.qualified_name,
      signature: r.signature,
      startLine: r.start_line,
      endLine: r.end_line,
      score: -(r.bm as number),
    }));
    const payload = { results };
    const json = JSON.stringify(payload);
    recordCodeNavSavings('code_symbol_search', estimateTokens(json), repoSlug ?? null);
    res.type('application/json').send(json);
  } catch (err: any) {
    logger.error('api/code-symbol-search failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/code-symbol-get', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const { getCodeDb } = await import('./lib/code-nav/db.js');
    const { resolveRepoById, getRepoPathOnMachine } = await import('./lib/code-nav/repos.js');
    const { normalizeNewlines } = await import('./lib/code-nav/parser.js');
    const { recordCodeNavSavings, estimateTokens } = await import('./lib/code-nav/savings.js');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const body = req.body as { id?: string; max_body_lines?: number };
    const id = (body.id ?? '').toString();
    if (!/^[0-9a-f]{16}$/.test(id)) {
      res.status(400).json({ error: 'id must be 16 lowercase hex chars' });
      return;
    }
    const maxBody = Math.max(0, Math.min(200, Math.floor(body.max_body_lines ?? 200)));
    const db = getCodeDb();
    const sym = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(id) as
      | {
          id: string;
          repo_id: string;
          relative_path: string;
          name: string;
          kind: string;
          qualified_name: string;
          signature: string | null;
          docstring: string | null;
          start_line: number;
          end_line: number;
          parent_id: string | null;
          content_hash: string;
        }
      | undefined;
    if (!sym) {
      res.status(404).json({ error: `Symbol not found: ${id}` });
      return;
    }
    const repo = resolveRepoById(sym.repo_id);
    const repoSlug = repo?.slug ?? sym.repo_id;
    const repoAbs = getRepoPathOnMachine(sym.repo_id);

    let bodyText = '';
    let truncated = false;
    if (repoAbs) {
      const abs = path.join(repoAbs, sym.relative_path);
      try {
        const raw = await fs.readFile(abs, 'utf-8');
        const lines = normalizeNewlines(raw).split('\n');
        const start = Math.max(0, sym.start_line - 1);
        const end = Math.min(lines.length, sym.end_line);
        let slice = lines.slice(start, end);
        if (slice.length > maxBody) {
          slice = slice.slice(0, maxBody);
          truncated = true;
        }
        bodyText = slice.join('\n');
      } catch (e: any) {
        bodyText = `<unable to read file: ${e?.message ?? String(e)}>`;
      }
    } else {
      bodyText = '<repo path not registered on this machine>';
    }

    const payload = {
      id: sym.id,
      repo: repoSlug,
      path: sym.relative_path,
      name: sym.name,
      kind: sym.kind,
      qualifiedName: sym.qualified_name,
      signature: sym.signature,
      docstring: sym.docstring,
      startLine: sym.start_line,
      endLine: sym.end_line,
      parentId: sym.parent_id,
      body: bodyText,
      truncated,
    };
    const json = JSON.stringify(payload);
    recordCodeNavSavings('code_symbol_get', estimateTokens(json), repoSlug);
    res.type('application/json').send(json);
  } catch (err: any) {
    logger.error('api/code-symbol-get failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/code-file-outline', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const { getCodeDb } = await import('./lib/code-nav/db.js');
    const { resolveRepoBySlug } = await import('./lib/code-nav/repos.js');
    const { recordCodeNavSavings, estimateTokens } = await import('./lib/code-nav/savings.js');
    const body = req.body as { repo?: string; path?: string };
    const slug = (body.repo ?? '').toString();
    const filePath = (body.path ?? '').toString();
    if (!slug || !filePath) {
      res.status(400).json({ error: 'repo and path are required' });
      return;
    }
    const repo = resolveRepoBySlug(slug);
    if (!repo) {
      res.status(404).json({ error: `Unknown repo slug: ${slug}` });
      return;
    }
    const db = getCodeDb();
    const rows = db
      .prepare(
        `SELECT id, kind, name, qualified_name, signature, start_line, end_line, parent_id
           FROM symbols WHERE repo_id=? AND relative_path=? ORDER BY start_line`,
      )
      .all(repo.id, filePath) as Array<{
      id: string;
      kind: string;
      name: string;
      qualified_name: string;
      signature: string | null;
      start_line: number;
      end_line: number;
      parent_id: string | null;
    }>;
    const symbols = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      qualifiedName: r.qualified_name,
      signature: r.signature,
      startLine: r.start_line,
      endLine: r.end_line,
      parentId: r.parent_id,
    }));
    const payload = { repo: slug, path: filePath, symbols };
    const json = JSON.stringify(payload);
    recordCodeNavSavings('code_file_outline', estimateTokens(json), slug);
    res.type('application/json').send(json);
  } catch (err: any) {
    logger.error('api/code-file-outline failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/code-change-impact', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const { getCodeDb } = await import('./lib/code-nav/db.js');
    const { recordCodeNavSavings, estimateTokens } = await import('./lib/code-nav/savings.js');
    const body = req.body as { id?: string; depth?: number; limit?: number };
    const id = (body.id ?? '').toString();
    if (!/^[0-9a-f]{16}$/.test(id)) {
      res.status(400).json({ error: 'id must be 16 lowercase hex chars' });
      return;
    }
    const depth = Math.max(1, Math.min(5, Math.floor(body.depth ?? 3)));
    const limit = Math.max(1, Math.min(500, Math.floor(body.limit ?? 100)));
    const db = getCodeDb();
    const root = db.prepare(`SELECT * FROM symbols WHERE id=?`).get(id) as
      | {
          id: string;
          repo_id: string;
          relative_path: string;
          name: string;
          kind: string;
        }
      | undefined;
    if (!root) {
      res.status(404).json({ error: `Symbol not found: ${id}` });
      return;
    }
    const slugRows = db.prepare(`SELECT id, slug FROM repos`).all() as { id: string; slug: string }[];
    const slugFor = new Map(slugRows.map((r) => [r.id, r.slug]));
    const sql = `
      WITH RECURSIVE impact(id, distance) AS (
        SELECT c.caller_id AS id, 1 AS distance
          FROM calls c
         WHERE c.callee_id = ?
        UNION
        SELECT c.caller_id AS id, i.distance + 1 AS distance
          FROM calls c
          JOIN impact i ON c.callee_id = i.id
         WHERE i.distance < ?
           AND c.caller_id IS NOT NULL
      )
      SELECT s.id, s.repo_id, s.relative_path, s.name, s.kind,
             MIN(i.distance) AS distance
        FROM impact i
        JOIN symbols s ON s.id = i.id
       WHERE s.id <> ?
       GROUP BY s.id
       ORDER BY distance ASC, s.name ASC
       LIMIT ?
    `;
    const rows = db.prepare(sql).all(id, depth, id, limit + 1) as Array<{
      id: string;
      repo_id: string;
      relative_path: string;
      name: string;
      kind: string;
      distance: number;
    }>;
    const truncated = rows.length > limit;
    const trimmed = truncated ? rows.slice(0, limit) : rows;
    const transitiveCallers = trimmed.map((r) => ({
      id: r.id,
      repo: slugFor.get(r.repo_id) ?? r.repo_id,
      path: r.relative_path,
      name: r.name,
      kind: r.kind,
      distance: r.distance,
    }));
    const rootRepoSlug = slugFor.get(root.repo_id) ?? root.repo_id;
    const payload = {
      root: {
        id: root.id,
        repo: rootRepoSlug,
        path: root.relative_path,
        name: root.name,
        kind: root.kind,
      },
      transitiveCallers,
      totalCount: transitiveCallers.length,
      truncated,
    };
    const json = JSON.stringify(payload);
    recordCodeNavSavings('code_change_impact', estimateTokens(json), rootRepoSlug);
    res.type('application/json').send(json);
  } catch (err: any) {
    logger.error('api/code-change-impact failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post(
  '/api/code-call-chain',
  apiKeyMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { computeCallChain } = await import('./tools/code-nav.js');
      const { recordCodeNavSavings, estimateTokens } = await import('./lib/code-nav/savings.js');
      const body = req.body as { source?: string; target?: string; max_depth?: number };
      const source = (body.source ?? '').toString();
      const target = (body.target ?? '').toString();
      if (!/^[0-9a-f]{16}$/.test(source) || !/^[0-9a-f]{16}$/.test(target)) {
        res.status(400).json({ error: 'source and target must be 16 lowercase hex chars' });
        return;
      }
      let payload: Record<string, unknown>;
      try {
        ({ payload } = computeCallChain({ source, target, max_depth: body.max_depth }));
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (msg.startsWith('Source symbol not found') || msg.startsWith('Target symbol not found')) {
          res.status(404).json({ error: msg });
          return;
        }
        throw e;
      }
      const json = JSON.stringify(payload);
      const repoSlug = (payload.source as { repo?: string } | undefined)?.repo ?? null;
      recordCodeNavSavings('code_call_chain', estimateTokens(json), repoSlug);
      res.type('application/json').send(json);
    } catch (err: any) {
      logger.error('api/code-call-chain failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  },
);

app.post(
  '/api/code-find-semantic-duplicates',
  apiKeyMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { computeFindSemanticDuplicates } = await import('./tools/code-nav.js');
      const { recordCodeNavSavings, estimateTokens } = await import('./lib/code-nav/savings.js');
      const body = req.body as {
        repo?: string;
        mode?: string;
        kind?: string;
        min_cluster_size?: number;
        min_signature_length?: number;
        max_hamming?: number;
        limit?: number;
      };
      const slug = (body.repo ?? '').toString();
      if (!slug) {
        res.status(400).json({ error: 'repo is required' });
        return;
      }
      const mode = (body.mode ?? 'exact') as 'exact' | 'structural' | 'body';
      if (mode !== 'exact' && mode !== 'structural' && mode !== 'body') {
        res
          .status(400)
          .json({ error: `mode must be one of: exact, structural, body (got '${body.mode}')` });
        return;
      }
      const params = {
        repo: slug,
        mode,
        kind: body.kind,
        min_cluster_size: body.min_cluster_size,
        min_signature_length: body.min_signature_length,
        max_hamming: body.max_hamming,
        limit: body.limit,
      };
      let payload: Record<string, unknown>;
      try {
        ({ payload } = computeFindSemanticDuplicates(params));
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (msg.startsWith('Unknown repo slug:')) {
          res.status(404).json({ error: msg });
          return;
        }
        if (msg.startsWith('Too many fingerprinted symbols')) {
          res.status(413).json({ error: msg });
          return;
        }
        throw e;
      }
      const json = JSON.stringify(payload);
      recordCodeNavSavings('code_find_semantic_duplicates', estimateTokens(json), slug);
      res.type('application/json').send(json);
    } catch (err: any) {
      logger.error('api/code-find-semantic-duplicates failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  },
);

// POST /mine — conversation mining endpoint (API key auth)
app.post('/mine', apiKeyMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body as { content?: string; format?: string };
    if (!body.content) {
      res.status(400).json({ error: 'Missing "content" field' });
      return;
    }
    const format = (body.format as string | undefined) ?? autoDetectFormat(body.content);
    const exchanges = normalizeConversation(body.content, format as any);
    const memories = extractMemories(exchanges);
    res.json({
      format,
      exchangesParsed: exchanges.length,
      memoriesExtracted: memories.length,
      memories: memories.slice(0, 50),
    });
  } catch (err: any) {
    logger.error('Mining failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /benchmark — trigger retrieval benchmark (Authelia-protected)
app.post('/benchmark', dashboardAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const dataset = (req.body as { dataset?: string })?.dataset ?? 'benchmarks/internal.jsonl';
    const limit = (req.body as { limit?: number })?.limit;
    const result = await runQualityBenchmark(dataset, limit);
    res.json(result);
  } catch (err: any) {
    logger.error('Benchmark failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /repair — trigger index repair (Authelia-protected)
app.post('/repair', dashboardAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const target = (req.body as { target?: string })?.target ?? 'all';
    const results: Record<string, string> = {};

    if (target === 'all' || target === 'lexical') {
      forceFullRebuild();
      await rebuildIndex();
      results.lexical = 'rebuilt';
    }
    if (target === 'all' || target === 'semantic') {
      if (isEmbeddingsReady()) {
        const dm = getDocMeta();
        const docTexts = new Map<string, { title: string; content: string }>();
        for (const [p, meta] of dm) {
          docTexts.set(p, { title: meta.title, content: meta.content });
        }
        await buildFullIndex(docTexts);
        results.semantic = 'rebuilt';
      } else {
        results.semantic = 'skipped (embeddings not ready)';
      }
    }
    if (target === 'all' || target === 'graph') {
      await buildAndCacheGraph();
      results.graph = 'rebuilt';
    }
    if (target === 'all' || target === 'kg') {
      if (isKgInitialized()) {
        const kgResult = kgRepair();
        results.kg = `${kgResult.status}: ${kgResult.detail}`;
      } else {
        results.kg = 'skipped (KG not enabled)';
      }
    }

    res.json({ target, results });
  } catch (err: any) {
    logger.error('Repair failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /dream — trigger dream cycle (Authelia-protected, cron-friendly)
app.post('/dream', dashboardAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const body = req.body as {
      daysBack?: number;
      autoDecay?: boolean;
      autoArchive?: boolean;
      maxThemes?: number;
      maxOrphans?: number;
      maxConnections?: number;
      maxConsolidations?: number;
      llmConsolidate?: boolean;
    };

    const report = await runDreamCycle({
      daysBack: body.daysBack,
      autoDecay: body.autoDecay,
      autoArchive: body.autoArchive,
      maxThemes: body.maxThemes,
      maxOrphans: body.maxOrphans,
      maxConnections: body.maxConnections,
      maxConsolidations: body.maxConsolidations,
    });

    // If LLM consolidation requested and local LLM is available (via reranker config)
    let llmSuggestions: Array<{ group: string; summary: string }> = [];
    if (body.llmConsolidate && config.enableReranker && config.rerankerBaseUrl && report.consolidationGroups.length > 0) {
      try {
        const topGroups = report.consolidationGroups.slice(0, 3);
        for (const group of topGroups) {
          const prompt = `You are a memory consolidation assistant. Given these related memory note paths that share tags [${group.commonTags.join(', ')}], suggest a concise 2-3 sentence summary title and content that captures the common theme. Paths: ${group.paths.join(', ')}. Suggested title: "${group.suggestedTitle}". Respond with JSON: {"title": "...", "summary": "..."}`;

          const llmRes = await fetch(`${config.rerankerBaseUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(config.rerankerApiKey ? { 'Authorization': `Bearer ${config.rerankerApiKey}` } : {}),
            },
            body: JSON.stringify({
              model: config.rerankerModel,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 200,
              temperature: 0.3,
            }),
            signal: AbortSignal.timeout(config.rerankerTimeoutMs),
          });

          if (llmRes.ok) {
            const data = await llmRes.json() as any;
            const text = data?.choices?.[0]?.message?.content ?? '';
            llmSuggestions.push({ group: group.suggestedTitle, summary: text });
          }
        }
      } catch (llmErr: any) {
        logger.warn('Dream LLM consolidation failed', { error: llmErr.message });
      }
    }

    // Journal entry
    await appendJournalEntry(
      `Automated dream cycle: ${report.themes.length} themes, ${report.orphans.length} orphans, ` +
      `${report.connectionSuggestions.length} connections, ${report.consolidationGroups.length} consolidation groups. ` +
      `Decayed: ${report.lifecycle.decayed}, Archived: ${report.lifecycle.archived.length}` +
      (llmSuggestions.length > 0 ? `. LLM generated ${llmSuggestions.length} consolidation summaries` : '')
    );

    res.json({
      ...report,
      llmSuggestions: llmSuggestions.length > 0 ? llmSuggestions : undefined,
    });
  } catch (err: any) {
    logger.error('Dream cycle failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Metrics endpoint (Authelia-protected)
app.get('/metrics', dashboardAuthMiddleware, (_req, res) => {
  res.json(getMetrics());
});

// Prometheus / OpenMetrics export endpoint (Authelia-protected)
app.get('/metrics/prometheus', dashboardAuthMiddleware, (_req, res) => {
  const m = getMetrics();
  const dm = getDocMeta();

  // Compute current temperature counts from doc metadata
  let tempHot = 0, tempWarm = 0, tempCold = 0;
  for (const [, meta] of dm) {
    if (meta.temperature === 'hot') tempHot++;
    else if (meta.temperature === 'warm') tempWarm++;
    else if (meta.temperature === 'cold') tempCold++;
  }

  // Helper: compute p95 from a sorted array of latencies
  function p95(latencies: number[]): number {
    if (latencies.length === 0) return 0;
    const sorted = [...latencies].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, idx)];
  }

  const lines: string[] = [];

  // --- requests_total (counter, by category) ---
  lines.push('# HELP cortexmd_requests_total Total HTTP requests by category.');
  lines.push('# TYPE cortexmd_requests_total counter');
  for (const cat of ['health', 'mcp', 'oauth', 'dashboard', 'other'] as const) {
    lines.push(`cortexmd_requests_total{category="${cat}"} ${m.requestsByCategory[cat]}`);
  }

  // --- errors_total ---
  lines.push('# HELP cortexmd_errors_total Total error responses (HTTP >= 400).');
  lines.push('# TYPE cortexmd_errors_total counter');
  lines.push(`cortexmd_errors_total ${m.errorResponses}`);

  // --- active_sessions ---
  lines.push('# HELP cortexmd_active_sessions Number of active MCP sessions.');
  lines.push('# TYPE cortexmd_active_sessions gauge');
  lines.push(`cortexmd_active_sessions ${m.activeSessionsCount}`);

  // --- indexed_notes ---
  lines.push('# HELP cortexmd_indexed_notes Number of notes in the search index.');
  lines.push('# TYPE cortexmd_indexed_notes gauge');
  lines.push(`cortexmd_indexed_notes ${m.indexedNotes}`);

  // --- uptime_seconds ---
  lines.push('# HELP cortexmd_uptime_seconds Server uptime in seconds.');
  lines.push('# TYPE cortexmd_uptime_seconds gauge');
  lines.push(`cortexmd_uptime_seconds ${(m.uptime / 1000).toFixed(1)}`);

  // --- tool_calls_total (counter, by tool) ---
  lines.push('# HELP cortexmd_tool_calls_total Total tool invocations by tool name.');
  lines.push('# TYPE cortexmd_tool_calls_total counter');
  for (const [tool, tc] of Object.entries(m.toolCalls)) {
    lines.push(`cortexmd_tool_calls_total{tool="${tool}"} ${tc.count}`);
  }

  // --- tool_errors_total (counter, by tool) ---
  lines.push('# HELP cortexmd_tool_errors_total Total tool errors by tool name.');
  lines.push('# TYPE cortexmd_tool_errors_total counter');
  for (const [tool, tc] of Object.entries(m.toolCalls)) {
    lines.push(`cortexmd_tool_errors_total{tool="${tool}"} ${tc.errors}`);
  }

  // --- tool_latency_avg_ms (gauge, by tool) ---
  lines.push('# HELP cortexmd_tool_latency_avg_ms Average tool latency in milliseconds.');
  lines.push('# TYPE cortexmd_tool_latency_avg_ms gauge');
  for (const [tool, tc] of Object.entries(m.toolCalls)) {
    const avg = tc.count > 0 ? (tc.totalLatency / tc.count).toFixed(1) : '0';
    lines.push(`cortexmd_tool_latency_avg_ms{tool="${tool}"} ${avg}`);
  }

  // --- tool_latency_p95_ms (gauge, by tool) ---
  lines.push('# HELP cortexmd_tool_latency_p95_ms 95th percentile tool latency in milliseconds.');
  lines.push('# TYPE cortexmd_tool_latency_p95_ms gauge');
  for (const [tool, tc] of Object.entries(m.toolCalls)) {
    lines.push(`cortexmd_tool_latency_p95_ms{tool="${tool}"} ${p95(tc.latencies)}`);
  }

  // --- memory_temperature (gauge, by level) ---
  lines.push('# HELP cortexmd_memory_temperature Number of notes by temperature level.');
  lines.push('# TYPE cortexmd_memory_temperature gauge');
  lines.push(`cortexmd_memory_temperature{level="hot"} ${tempHot}`);
  lines.push(`cortexmd_memory_temperature{level="warm"} ${tempWarm}`);
  lines.push(`cortexmd_memory_temperature{level="cold"} ${tempCold}`);

  // --- search_total ---
  lines.push('# HELP cortexmd_search_total Total search queries.');
  lines.push('# TYPE cortexmd_search_total counter');
  lines.push(`cortexmd_search_total ${m.searchStats.totalSearches}`);

  // --- search_zero_results_total ---
  lines.push('# HELP cortexmd_search_zero_results_total Total search queries returning zero results.');
  lines.push('# TYPE cortexmd_search_zero_results_total counter');
  lines.push(`cortexmd_search_zero_results_total ${m.searchStats.zeroResultCount}`);

  // --- search_avg_latency_ms ---
  lines.push('# HELP cortexmd_search_avg_latency_ms Average search query latency in milliseconds.');
  lines.push('# TYPE cortexmd_search_avg_latency_ms gauge');
  lines.push(`cortexmd_search_avg_latency_ms ${m.searchStats.avgLatencyMs}`);

  // --- search_type_hits (counter, by type) ---
  lines.push('# HELP cortexmd_search_type_hits Search result hits by source type.');
  lines.push('# TYPE cortexmd_search_type_hits counter');
  lines.push(`cortexmd_search_type_hits{type="lexical_only"} ${m.searchTypeStats.lexicalOnlyHits}`);
  lines.push(`cortexmd_search_type_hits{type="semantic_only"} ${m.searchTypeStats.semanticOnlyHits}`);
  lines.push(`cortexmd_search_type_hits{type="both"} ${m.searchTypeStats.bothHits}`);

  // --- vault_health (gauge) ---
  if (m.vaultHealth) {
    lines.push('# HELP cortexmd_vault_total_files Total files in vault.');
    lines.push('# TYPE cortexmd_vault_total_files gauge');
    lines.push(`cortexmd_vault_total_files ${m.vaultHealth.totalFiles}`);

    lines.push('# HELP cortexmd_vault_archived_notes Archived notes count.');
    lines.push('# TYPE cortexmd_vault_archived_notes gauge');
    lines.push(`cortexmd_vault_archived_notes ${m.vaultHealth.archivedNotes}`);

    lines.push('# HELP cortexmd_vault_stale_notes Notes not accessed in 60+ days.');
    lines.push('# TYPE cortexmd_vault_stale_notes gauge');
    lines.push(`cortexmd_vault_stale_notes ${m.vaultHealth.staleNotes}`);
  }

  // --- link_density (gauge) ---
  if (m.linkDensity) {
    lines.push('# HELP cortexmd_link_total Total wiki-links in vault.');
    lines.push('# TYPE cortexmd_link_total gauge');
    lines.push(`cortexmd_link_total ${m.linkDensity.totalLinks}`);

    lines.push('# HELP cortexmd_link_avg_per_note Average wiki-links per note.');
    lines.push('# TYPE cortexmd_link_avg_per_note gauge');
    lines.push(`cortexmd_link_avg_per_note ${m.linkDensity.avgLinksPerNote.toFixed(2)}`);

    lines.push('# HELP cortexmd_orphan_notes Notes with no links in or out.');
    lines.push('# TYPE cortexmd_orphan_notes gauge');
    lines.push(`cortexmd_orphan_notes ${m.linkDensity.orphanNotes}`);
  }

  // --- memory_lifecycle (counter) ---
  lines.push('# HELP cortexmd_memory_archived_total Total notes archived via tool.');
  lines.push('# TYPE cortexmd_memory_archived_total counter');
  lines.push(`cortexmd_memory_archived_total ${m.memoryLifecycle.totalArchived}`);

  lines.push('# HELP cortexmd_memory_consolidated_total Total consolidation operations.');
  lines.push('# TYPE cortexmd_memory_consolidated_total counter');
  lines.push(`cortexmd_memory_consolidated_total ${m.memoryLifecycle.totalConsolidated}`);

  // OpenMetrics requires a trailing EOF line
  lines.push('# EOF');

  res.setHeader('Content-Type', 'application/openmetrics-text; version=1.0.0; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// Debug endpoint — diagnose vault access issues (Authelia-protected)
app.get('/debug', dashboardAuthMiddleware, async (_req, res) => {
  const results: Record<string, unknown> = {
    pid: process.pid,
    uid: process.getuid?.() ?? 'N/A',
    gid: process.getgid?.() ?? 'N/A',
    cwd: process.cwd(),
    nodeVersion: process.version,
    env: {
      VAULT_RW: !!process.env.VAULT_RW,
      VAULT_RO_PERSO: !!process.env.VAULT_RO_PERSO,
      VAULT_RO_HAPLY: !!process.env.VAULT_RO_HAPLY,
      LOG_LEVEL: !!process.env.LOG_LEVEL,
    },
    config: {
      brainVault: config.brainVault,
      sourceVaults: config.sourceVaults,
      allVaults: config.allVaults,
    },
    vaults: {} as Record<string, unknown>,
    indexedNotes: getIndexedNoteCount(),
  };

  for (const vault of config.allVaults) {
    const vaultInfo: Record<string, unknown> = { path: vault };
    try {
      await access(vault, fsConstants.R_OK);
      vaultInfo.readable = true;
    } catch (err) {
      vaultInfo.readable = false;
      vaultInfo.accessError = String(err);
    }
    try {
      const st = await stat(vault);
      vaultInfo.isDirectory = st.isDirectory();
      vaultInfo.uid = st.uid;
      vaultInfo.gid = st.gid;
      vaultInfo.mode = '0' + (st.mode & 0o777).toString(8);
    } catch (err) {
      vaultInfo.statError = String(err);
    }
    try {
      const entries = await readdir(vault);
      vaultInfo.entryCount = entries.length;
      vaultInfo.sampleEntries = entries.slice(0, 10);
    } catch (err) {
      vaultInfo.readdirError = String(err);
    }
    (results.vaults as Record<string, unknown>)[vault] = vaultInfo;
  }

  res.json(results);
});

// ── Read-only source-vault management (Component C) ─────────────────────────
// REST surface for the dashboard "Read-only vaults" panel. All routes require a
// dashboard session / API-key / forward-auth credential (dashboardAuthMiddleware).
// Mutations go through the Component B store (addSourceVault / removeSourceVault),
// which emits a change event that triggers the debounced hot reindex.

/** Canonicalize for matching a vault path against per-vault index health. */
function canonicalForMatch(p: string): string {
  try {
    return realpathSync(p).replace(/\\/g, '/');
  } catch {
    return nodePath.resolve(p).replace(/\\/g, '/');
  }
}

/** Cheap per-vault indexed-doc count + status from the last index health pass. */
function indexInfoForVault(vaultPath: string): { indexedDocs?: number; status: string } {
  try {
    const health = getIndexHealth();
    const key = canonicalForMatch(vaultPath);
    const entry = health.find((h) => canonicalForMatch(h.vault) === key);
    if (!entry) return { status: 'pending' };
    const status = entry.permissionErrors > 0 || entry.otherErrors > 0 ? 'degraded' : 'ok';
    return { indexedDocs: entry.fileCount, status };
  } catch {
    return { status: 'unknown' };
  }
}

// GET /dashboard/api/source-vaults — list effective (env + persisted) read-only
// vaults. Lives under /dashboard so it shares the dashboard's auth scope (cookie
// session / API key / forward-auth Remote-User); a /api/* path is NOT covered by
// the proxy's /dashboard forward-auth and 401s.
app.get('/dashboard/api/source-vaults', dashboardAuthMiddleware, (_req: Request, res: Response) => {
  try {
    const envNames = new Set(config.sourceVaultConfigs.map((v) => v.name));
    const vaults = listSourceVaults().map((v) => {
      const info = indexInfoForVault(v.path);
      return {
        name: v.name,
        path: v.path,
        includeGlobs: v.includeGlobs ?? [],
        source: (envNames.has(v.name) ? 'env' : 'persisted') as 'env' | 'persisted',
        indexedDocs: info.indexedDocs,
        status: info.status,
      };
    });
    res.json({ vaults });
  } catch (err: any) {
    logger.error('api/source-vaults list failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

const addSourceVaultSchema = z.object({
  path: z.string().trim().min(1, 'path is required'),
  name: z.string().trim().min(1).optional(),
  includeGlobs: z.array(z.string()).optional(),
});

// POST /dashboard/api/source-vaults — register a new persisted read-only vault.
app.post('/dashboard/api/source-vaults', dashboardAuthMiddleware, (req: Request, res: Response) => {
  const parsed = addSourceVaultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    return;
  }
  try {
    const entry = addSourceVault(parsed.data);
    res.status(201).json({
      name: entry.name,
      path: entry.path,
      includeGlobs: entry.includeGlobs ?? [],
      source: 'persisted' as const,
    });
  } catch (err) {
    if (err instanceof SourceVaultError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('api/source-vaults add failed', { error: msg });
    res.status(500).json({ error: msg });
  }
});

// DELETE /dashboard/api/source-vaults/:name — remove a persisted read-only vault.
app.delete('/dashboard/api/source-vaults/:name', dashboardAuthMiddleware, (req: Request, res: Response) => {
  const name = String(req.params.name ?? '');
  try {
    removeSourceVault(name);
    res.json({ ok: true, removed: name });
  } catch (err) {
    if (err instanceof SourceVaultError) {
      // ENV_MANAGED / NOT_FOUND are client errors (env-managed or unknown name).
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('api/source-vaults remove failed', { error: msg });
    res.status(500).json({ error: msg });
  }
});

// Dashboard (Authelia-protected)
app.use('/dashboard', dashboardAuthMiddleware);
app.use(dashboardRouter);

// API key middleware for /mcp (MCP clients use Bearer token)
app.use('/mcp', apiKeyMiddleware);

// POST /mcp - handle MCP requests
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && sessions.has(sessionId)) {
    const entry = sessions.get(sessionId)!;
    transport = entry.transport;
    updateSessionActivity(sessionId);
  } else if (sessionId && isInitializeRequest(req.body)) {
    // Client is re-initializing with a previously-issued session ID (e.g. after
    // a server restart). Recreate the transport with the same ID so metadata
    // and tool history survive. Only safe on initialize — accepting any method
    // here would leave the transport half-initialized.
    const meta = persistedSessionMeta.get(sessionId);
    persistedSessionMeta.delete(sessionId);

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    const server = createServer();
    await server.connect(transport);

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      setActiveSessionsCount(sessions.size);
    };

    await transport.handleRequest(req, res, req.body);

    const sid = transport.sessionId;
    if (sid) {
      const user = res.locals.user as { sub?: string; clientId?: string } | undefined;
      const ip = req.headers['x-forwarded-for'] as string | undefined ?? req.socket.remoteAddress;
      sessions.set(sid, {
        transport,
        lastActivity: Date.now(),
        createdAt: meta?.createdAt ?? Date.now(),
        requestCount: (meta?.requestCount ?? 0) + 1,
        clientInfo: user ? { sub: user.sub, clientId: user.clientId } : meta?.clientInfo,
        ip: typeof ip === 'string' ? ip.split(',')[0].trim() : meta?.ip,
        toolCounts: { ...(meta?.toolCounts ?? {}) },
        lastTools: [...(meta?.lastTools ?? [])],
      });
      setActiveSessionsCount(sessions.size);
      logger.info('Session restored on reinit', { sessionId: sid, hadMeta: !!meta });
    }
    return;
  } else if (sessionId) {
    // Unknown session ID on a non-initialize request — return 404 per MCP spec.
    // The client should drop the stale session and POST a fresh initialize
    // (with or without the old session ID; both paths are supported).
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session expired — please reconnect' },
      id: null,
    });
    persistedSessionMeta.delete(sessionId);
    return;
  } else {
    // Create new transport and server for this session
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    const server = createServer();
    await server.connect(transport);

    // Store transport once session ID is assigned
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      setActiveSessionsCount(sessions.size);
    };

    // We need to handle the request first so the session ID gets assigned
    await transport.handleRequest(req, res, req.body);

    // After handling, store the transport by its assigned session ID
    const sid = transport.sessionId;
    if (sid) {
      const user = res.locals.user as { sub?: string; clientId?: string } | undefined;
      const ip = req.headers['x-forwarded-for'] as string | undefined ?? req.socket.remoteAddress;
      sessions.set(sid, {
        transport,
        lastActivity: Date.now(),
        createdAt: Date.now(),
        requestCount: 1,
        clientInfo: user ? { sub: user.sub, clientId: user.clientId } : undefined,
        ip: typeof ip === 'string' ? ip.split(',')[0].trim() : undefined,
        toolCounts: {},
        lastTools: [],
      });
      setActiveSessionsCount(sessions.size);
    }
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET /mcp - SSE stream for notifications
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }

  updateSessionActivity(sessionId);
  const entry = sessions.get(sessionId)!;
  await entry.transport.handleRequest(req, res, req.body);
});

// DELETE /mcp - close session
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }

  const entry = sessions.get(sessionId)!;
  await entry.transport.handleRequest(req, res, req.body);
  sessions.delete(sessionId);
  setActiveSessionsCount(sessions.size);
});

// Catch-all 404 — return JSON so MCP OAuth probes fail cleanly
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { error: err.message });
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Session cleanup interval
let sessionCleanupInterval: ReturnType<typeof setInterval> | undefined;
let indexRebuildInterval: ReturnType<typeof setInterval> | undefined;
let sessionPersistInterval: ReturnType<typeof setInterval> | undefined;
let sourceRefreshInterval: ReturnType<typeof setInterval> | undefined;

function cleanupSessions(): void {
  const timeout = config.sessionTimeoutMs;
  // timeout === 0 disables idle-based session eviction — sessions live until
  // their transport closes or a DELETE arrives.
  if (timeout > 0) {
    const now = Date.now();
    let cleaned = 0;

    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity > timeout) {
        try {
          entry.transport.close?.();
        } catch {
          // ignore close errors
        }
        sessions.delete(sid);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      setActiveSessionsCount(sessions.size);
      logger.info('Session cleanup', { cleaned, remaining: sessions.size });
    }
  }

  // Clean up expired rate-limit entries
  cleanupExpired(3_600_000);
}

// Start server
async function main(): Promise<void> {
  console.log('[cortexmd] Starting up...');
  console.log('[cortexmd] Vaults:', JSON.stringify(config.allVaults));
  console.log('[cortexmd] UID:', process.getuid?.() ?? 'N/A', 'GID:', process.getgid?.() ?? 'N/A');

  // Start embedding model loading in parallel with index build (model load is I/O-bound)
  const embeddingsInitPromise = config.enableEmbeddings ? initEmbeddings() : null;

  // Initialize knowledge graph (SQLite) if enabled
  if (config.kgEnabled) {
    initKnowledgeGraph();
    console.log('[cortexmd] Knowledge graph initialized');
  }

  await rebuildIndex();
  console.log('[cortexmd] Index built, notes:', getIndexedNoteCount());

  // Hot reindex on runtime source-vault add/remove (Component B). Debounced so a
  // burst of changes coalesces into a single full rebuild; a removed vault's
  // docs are dropped by the full scan in reindexSourceVaults().
  let sourceVaultReindexTimer: NodeJS.Timeout | undefined;
  onSourceVaultsChanged(() => {
    if (sourceVaultReindexTimer) clearTimeout(sourceVaultReindexTimer);
    sourceVaultReindexTimer = setTimeout(() => {
      reindexSourceVaults().catch((err) => {
        logger.error('Source-vault reindex failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 500);
    sourceVaultReindexTimer.unref?.();
  });

  // Load persisted metrics + sessions early so they're available when the server starts
  initMetricsFromDisk(config.dataDir);

  // Restore session metadata from previous run. Retention is independent of the
  // idle-sweep timeout (which may be 0/disabled) — we keep persisted metadata
  // for sessionRetentionMs (default 30d) so clients that reconnect with an old
  // session ID on initialize can recover their metadata.
  const restoredSessions = loadSessions(config.dataDir);
  for (const s of restoredSessions) {
    if (Date.now() - s.lastActivity < config.sessionRetentionMs) {
      persistedSessionMeta.set(s.sessionId, s);
    }
  }
  if (restoredSessions.length > 0) {
    logger.info('Restored session metadata', { count: persistedSessionMeta.size, total: restoredSessions.length });
  }

  // ── Start accepting connections NOW ────────────────────────────────────
  // Lexical search is ready, sessions are restored. Embeddings, graph,
  // and benchmark build in the background — search degrades gracefully
  // (lexical-only) until the semantic index finishes.

  // Register samplers for dashboard
  registerTemperatureSampler(() => {
    const dm = getDocMeta();
    let hot = 0, warm = 0, cold = 0;
    for (const [, meta] of dm) {
      if (meta.temperature === 'hot') hot++;
      else if (meta.temperature === 'warm') warm++;
      else if (meta.temperature === 'cold') cold++;
    }
    return { hot, warm, cold };
  });
  registerVaultHealthSampler(() => getVaultHealth());
  registerLinkDensitySampler(() => {
    const stats = getGraphStats();
    if (!stats) return { totalLinks: 0, avgLinksPerNote: 0, orphanNotes: 0, mostLinked: [] };
    return stats;
  });
  registerCodeNavSampler(() => getCodeNavStats());

  // ── Code-nav bootstrap ────────────────────────────────────────────────
  // 1. probe git (clean error if missing; non-fatal — tools throw at use time)
  // 2. ensure DB schema exists
  // 3. pull repos from vault registry into local DB
  // 4. silent-bootstrap any CODE_REPOS env entries (phase-1 backward compat)
  try {
    const git = probeGit();
    if (!git.ok) {
      logger.warn('git not available — code-nav register/scan tools will fail until git is installed', {
        error: git.error,
      });
    } else {
      logger.info('git probe ok', { version: git.version });
    }
    getCodeDb(); // ensure schema
    const reg = await readVaultRegistry();
    if (reg && reg.repos.length > 0) {
      const { inserted, updated } = loadVaultRegistryIntoDb(reg.repos);
      logger.info('Loaded vault code registry', {
        repos: reg.repos.length,
        inserted,
        updated,
      });
    }
    // Bootstrap CODE_REPOS env entries silently. Failures are logged + skipped.
    if (config.codeRepos.length > 0) {
      const { default: pathLib } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const reposMod = await import('./lib/code-nav/repos.js');
      const dbHandle = getCodeDb();
      const machineId = reposMod.getMachineId();
      for (const cr of config.codeRepos) {
        try {
          const abs = pathLib.resolve(cr.absolutePath);
          if (!existsSync(pathLib.join(abs, '.git'))) {
            logger.warn('CODE_REPOS bootstrap skipped (no .git)', { path: abs });
            continue;
          }
          const sha = await reposMod.firstCommitSha(abs);
          const id = sha.slice(0, 16);
          const origin = await reposMod.gitOrigin(abs);
          const slug = cr.name;
          const now = Date.now();
          dbHandle.prepare(
            `INSERT OR IGNORE INTO repos (id, slug, git_origin, first_commit_sha, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(id, slug, origin, sha, now);
          dbHandle.prepare(
            `INSERT INTO repo_paths (repo_id, machine_id, abs_path, registered_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(repo_id, machine_id) DO UPDATE SET
               abs_path = excluded.abs_path,
               last_seen_at = excluded.last_seen_at`,
          ).run(id, machineId, abs, now, now);
          logger.info('CODE_REPOS bootstrap registered', { slug, id, abs });
        } catch (err) {
          logger.warn('CODE_REPOS bootstrap failed', {
            slug: cr.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Mirror to vault registry once, after all bootstraps.
      try {
        const { writeVaultRegistry } = await import('./lib/code-nav/registry.js');
        await writeVaultRegistry();
      } catch { /* ignore */ }
    }
  } catch (err) {
    logger.error('Code-nav bootstrap failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  startMetricsSampling(config.metricsFlushIntervalMs, config.dataDir);
  sessionPersistInterval = setInterval(() => {
    saveSessions(config.dataDir, getSessionsForPersistence());
  }, config.metricsFlushIntervalMs);
  indexRebuildInterval = setInterval(() => {
    rebuildIndex().catch((err) => {
      logger.error('Background index rebuild failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, config.indexRebuildIntervalMs);
  sessionCleanupInterval = setInterval(cleanupSessions, 60_000);

  // ── Source-vault refresh (git-pull transport) ─────────
  // Periodically re-pull source vaults so the next index rebuild sees upstream
  // changes. Read-only sources need no merge — refresh() is fast-forward only
  // (see git-pull-vault.ts). Only meaningful in HTTP mode, where sources arrive
  // over a transport; LocalVault.refresh() is a no-op so a local-only config
  // pays nothing. Gated on having sources and a positive interval. Prefer the
  // shared scheduler (overlap-guarded); fall back to a plain setInterval if it
  // is somehow unavailable.
  if (sourceVaultTransports().length > 0 && config.sourceRefreshIntervalMs > 0) {
    const refreshHandler = async (): Promise<void> => {
      await refreshSourceVaults();
    };
    if (typeof registerJob === 'function') {
      registerJob({
        name: 'source_vault_refresh',
        intervalMs: config.sourceRefreshIntervalMs,
        handler: refreshHandler,
      });
      logger.info('Source-vault refresh scheduled', {
        intervalMs: config.sourceRefreshIntervalMs,
        sources: sourceVaultTransports().length,
      });
    } else {
      sourceRefreshInterval = setInterval(() => {
        refreshHandler().catch((err) => {
          logger.error('Source-vault refresh failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, config.sourceRefreshIntervalMs);
      if (sourceRefreshInterval.unref) sourceRefreshInterval.unref();
    }
  }

  // AGENT-C scheduler wiring: nightly dream + 12h temperature refresh.
  // Gated behind DREAM_SCHEDULE=on so it's opt-in until the user has
  // confirmed the server is happy running these at scale.
  if ((process.env.DREAM_SCHEDULE ?? 'off').toLowerCase() === 'on') {
    // TODO: parseSimpleCron only accepts "M H * * *". Use a full cron parser
    // if we ever need weekday/month specifiers.
    registerJob({
      name: 'memory_dream',
      cron: process.env.DREAM_CRON ?? '0 3 * * *',
      handler: async () => {
        const report = await runDreamCycle({
          autoDecay: true,
          autoArchive: false,
        });
        await appendJournalEntry(
          `Scheduled dream cycle: ${report.themes.length} themes, ${report.orphans.length} orphans, ` +
          `${report.connectionSuggestions.length} connections, ${report.consolidationGroups.length} consolidation groups. ` +
          `Decayed: ${report.lifecycle.decayed}, Archived: ${report.lifecycle.archived.length}`,
        );
      },
    });

    registerJob({
      name: 'memory_temperature_refresh',
      intervalMs: 12 * 60 * 60 * 1000,
      handler: async () => {
        const decay = await decayMemories();
        const archive = await autoArchiveColdMemories();
        await appendJournalEntry(
          `Scheduled temperature refresh: decayed ${decay.decayed}, archived ${archive.archived.length}, skipped unique ${archive.skippedUnique}`,
        );
      },
    });

    logger.info('Scheduler enabled (DREAM_SCHEDULE=on)');
  } else {
    logger.info('Scheduler disabled — set DREAM_SCHEDULE=on to enable nightly dream + temperature refresh');
  }

  const server = app.listen(config.port, () => {
    logger.info(`cortexmd listening on port ${config.port}`);
  });

  // ── Background: heavy I/O that doesn't block request handling ─────────

  // Build link graph (reads all files, builds adjacency map)
  buildAndCacheGraph().then(() => {
    console.log('[cortexmd] Link graph cached');
  }).catch(err => {
    logger.error('Link graph build failed', { error: err instanceof Error ? err.message : String(err) });
  });

  // Build embedding index (model load + vectorize 1000+ docs)
  if (config.enableEmbeddings && embeddingsInitPromise) {
    embeddingsInitPromise.then(async () => {
      const dm = getDocMeta();
      const docTexts = new Map<string, { title: string; content: string }>();
      for (const [p, meta] of dm) {
        docTexts.set(p, { title: meta.title, content: meta.content });
      }
      try {
        // Fast path: a persisted index loaded from disk, so only reconcile the
        // delta (new/changed/deleted notes) instead of re-embedding the whole
        // vault. A full rebuild is the cold-start / corrupt-index fallback.
        if (wasPersistedIndexLoaded()) {
          await syncIndexIncremental(docTexts);
        } else {
          await buildFullIndex(docTexts);
        }
      } catch (err) {
        logger.error('Embedding index build crashed', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
      const { getEmbeddingStats } = await import('./lib/embeddings.js');
      const stats = getEmbeddingStats();
      console.log('[cortexmd] Embeddings:', stats.ready ? `ready (${stats.indexSize} vectors)` : 'disabled/failed');

      // Build tool-description embeddings for `tool_search` once the
      // model is loaded. Cheap (~ tool-count × 1ms) and runs once.
      buildToolEmbeddings().catch((err) => {
        logger.warn('buildToolEmbeddings failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }).catch(err => {
      logger.error('Embeddings init failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  // Run retrieval benchmark (non-blocking)
  import('./lib/benchmark.js').then(async ({ runBenchmark }) => {
    const summary = await runBenchmark();
    const { setBenchmarkResults } = await import('./lib/metrics.js');
    setBenchmarkResults(summary);
    logger.info('Retrieval benchmark completed', {
      queries: summary.totalQueries,
      avgLatencyMs: Math.round(summary.totalLatencyMs / summary.totalQueries),
    });
  }).catch(err => {
    logger.warn('Benchmark failed', { error: err instanceof Error ? err.message : String(err) });
  });

  // Graceful shutdown
  function shutdown(signal: string): void {
    logger.info(`Received ${signal}, shutting down gracefully`);

    // Close knowledge graph
    if (config.kgEnabled) {
      try { shutdownKG(); } catch { /* ignore */ }
    }

    // Persist embedding index
    if (isEmbeddingsReady()) {
      persistEmbeddingIndex();
    }

    // Persist session metadata for restoration after restart
    saveSessions(config.dataDir, getSessionsForPersistence());

    // Flush metrics to disk before shutting down
    persistMetricsToDisk(config.dataDir);
    stopMetricsSampling();

    if (sessionPersistInterval) clearInterval(sessionPersistInterval);
    if (sessionCleanupInterval) clearInterval(sessionCleanupInterval);
    if (indexRebuildInterval) clearInterval(indexRebuildInterval);
    if (sourceRefreshInterval) clearInterval(sourceRefreshInterval);

    // AGENT-C: stop scheduled jobs (includes source_vault_refresh if scheduled)
    stopAllJobs();

    // Close all transports
    for (const [sid, entry] of sessions) {
      try {
        entry.transport.close?.();
      } catch {
        // ignore close errors during shutdown
      }
      sessions.delete(sid);
    }

    server.close(() => {
      logger.info('Server shut down');
      process.exit(0);
    });

    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Failed to start server', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
