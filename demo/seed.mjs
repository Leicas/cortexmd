#!/usr/bin/env node
/**
 * Seeds the running cortexmd server with realistic brain-vault data by driving
 * its MCP tools over HTTP — exactly how a real AI agent (Claude Code, Cursor,
 * Codex) would. This is the part that makes the "shared memory" story concrete:
 * everything written here is immediately visible on the dashboard and to every
 * other connected agent.
 *
 * Speaks raw MCP (Streamable HTTP / JSON-RPC) with plain fetch, so it has zero
 * dependencies and runs from anywhere.
 *
 *   API_KEY=... MCP_URL=http://localhost:3000/mcp node demo/seed.mjs
 *
 * Env:
 *   MCP_URL   default http://localhost:3000/mcp
 *   API_KEY   required — the server prints it on first boot (or set it yourself)
 *   REPO_PATH default the cortexmd checkout — registered + code-indexed
 */
const MCP_URL = process.env.MCP_URL ?? 'http://localhost:3000/mcp';
const API_KEY = process.env.API_KEY ?? '';
const REPO_PATH = process.env.REPO_PATH ?? process.cwd();

if (!API_KEY) {
  console.error('Set API_KEY (the server prints it on first boot).');
  process.exit(1);
}

let sessionId = null;
let rpcId = 0;

/** Parse a Streamable-HTTP response body (JSON or SSE) into the JSON-RPC message. */
function parseBody(contentType, text) {
  if (contentType.includes('text/event-stream')) {
    // Concatenate every `data:` line, take the last JSON object (the response).
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        const json = line.slice(5).trim();
        if (json) { try { last = JSON.parse(json); } catch { /* skip */ } }
      }
    }
    return last;
  }
  return text ? JSON.parse(text) : null;
}

async function rpc(method, params, { notification = false } = {}) {
  const body = notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: ++rpcId, method, params };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${API_KEY}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  if (notification) return null;

  const text = await res.text();
  const msg = parseBody(res.headers.get('content-type') ?? '', text);
  if (msg?.error) throw new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  return msg?.result;
}

/** Call an MCP tool, tolerating per-tool failures so one bad seed doesn't abort. */
async function tool(name, args) {
  try {
    await rpc('tools/call', { name, arguments: args });
    process.stdout.write('.');
  } catch (err) {
    process.stdout.write('x');
    console.error(`\n  ${name} failed: ${err.message}`);
  }
}

/** Like tool(), but returns the tool's parsed JSON payload (or null). */
async function toolJson(name, args) {
  try {
    const r = await rpc('tools/call', { name, arguments: args });
    process.stdout.write('.');
    const txt = r?.content?.[0]?.text;
    return txt ? JSON.parse(txt) : null;
  } catch (err) {
    process.stdout.write('x');
    console.error(`\n  ${name} failed: ${err.message}`);
    return null;
  }
}

/** Trigger the dashboard's dream cycle over HTTP so the Intelligence tab fills.
 *  (The dashboard records its report from this endpoint, not the MCP tool.) */
async function dashboardDream() {
  const base = MCP_URL.replace(/\/mcp\/?$/, '');
  try {
    const res = await fetch(`${base}/dashboard/api/dream/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      // Analysis only — don't decay/archive the freshly-seeded memories.
      body: JSON.stringify({ daysBack: 30, autoDecay: false, autoArchive: false }),
    });
    process.stdout.write(res.ok ? '.' : 'x');
  } catch (err) {
    process.stdout.write('x');
    console.error(`\n  dashboard dream failed: ${err.message}`);
  }
}

async function main() {
  // ── MCP handshake ─────────────────────────────────────────────────────────
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cortexmd-demo-seed', version: '1.0.0' },
  });
  await rpc('notifications/initialized', {}, { notification: true });
  console.log(`Connected (session ${sessionId?.slice(0, 8)}…). Seeding…`);

  // ── Memories (auto-link entities + seed the knowledge graph) ────────────────
  const memories = [
    { category: 'decision', importance: 'high', title: 'Adopt hybrid retrieval (RRF)',
      tags: ['search', 'architecture'],
      relatedPaths: ['Projects/Helios Search.md', 'Decisions/Adopt Hybrid Retrieval.md'],
      content: 'Decided to fuse BM25 and vector search with Reciprocal Rank Fusion on [[Projects/Helios Search.md]]. [[CRM/People/Ada Lovelace.md]] led the eval; hybrid beat both baselines on every slice.' },
    { category: 'decision', importance: 'medium', title: 'Cap reranking at top-50',
      tags: ['search', 'cost'],
      relatedPaths: ['Decisions/Rerank Top-50 Only.md'],
      content: 'Reranking only the top-50 fused candidates keeps [[Projects/Helios Search.md]] p95 under 400ms. Beyond 50 the recall gain was noise. Owner [[CRM/People/Katherine Johnson.md]].' },
    { category: 'insight', importance: 'high', title: 'Heat decay half-life landed at 14 days',
      tags: ['memory', 'lifecycle'],
      relatedPaths: ['Projects/Memory Lifecycle.md', 'Decisions/Heat Decay Half-Life.md'],
      content: '[[CRM/People/Grace Hopper.md]] tuned the [[Projects/Memory Lifecycle.md]] decay so heat halves every 14 days. Shorter archived useful context; longer kept stale notes hot.' },
    { category: 'observation', importance: 'medium', title: 'Eval set caught a latency regression',
      tags: ['search', 'eval'],
      relatedPaths: ['Meetings/2026-06-01 Search Sync.md'],
      content: 'The offline eval harness flagged a 2x p95 jump after a reranker change. Reverted in the [[Meetings/2026-06-01 Search Sync.md]] sync. [[CRM/People/Katherine Johnson.md]] owns the harness.' },
    { category: 'plan', importance: 'high', title: 'Agent Mesh kickoff after write-path freeze',
      tags: ['agents', 'roadmap'],
      relatedPaths: ['Projects/Agent Mesh.md', 'Decisions/One Writer Brain Vault.md'],
      content: '[[Projects/Agent Mesh.md]] lets Claude Code, Cursor and Codex share one brain. Gated on freezing the single-writer path — see [[Decisions/One Writer Brain Vault.md]]. Sponsor [[CRM/People/Alan Turing.md]].' },
    { category: 'fact', importance: 'medium', title: 'RRF weights: 0.6 lexical / 0.4 semantic',
      tags: ['search', 'config'],
      content: 'The winning Reciprocal Rank Fusion weights from the sweep are 0.6 lexical / 0.4 semantic. Shipped behind a flag on [[Projects/Helios Search.md]].' },
    { category: 'preference', importance: 'low', title: 'ADRs live in Decisions/',
      tags: ['process'],
      content: 'Team preference: every architectural decision gets a short ADR under Decisions/ and links back to the owning project.' },
    { category: 'reflection', importance: 'medium', title: 'Single-writer model removed a class of bugs',
      tags: ['architecture'],
      relatedPaths: ['Decisions/One Writer Brain Vault.md'],
      content: 'Reflecting on the quarter: making the server the sole writer ([[Decisions/One Writer Brain Vault.md]]) eliminated the sync-clobber incidents we kept firefighting.' },
    { category: 'conversation', importance: 'low', title: 'Sync: flag rollout for hybrid search',
      tags: ['search'],
      relatedPaths: ['Meetings/2026-06-01 Search Sync.md'],
      content: 'In [[Meetings/2026-06-01 Search Sync.md]], [[CRM/People/Ada Lovelace.md]] and [[CRM/People/Katherine Johnson.md]] agreed to ship hybrid behind a flag and watch the eval dashboard.' },
    { category: 'observation', importance: 'medium', title: 'Cold tail is ~30% of the vault',
      tags: ['memory', 'lifecycle'],
      relatedPaths: ['Projects/Memory Lifecycle.md'],
      content: 'About a third of notes are cold and eligible for archival. The nightly dream pass proposes consolidations before archiving. Owner [[CRM/People/Grace Hopper.md]].' },
  ];
  for (const m of memories) await tool('memory_store', { ...m, skipDedupe: true });

  // ── Knowledge-graph triples (people ↔ projects ↔ decisions) ─────────────────
  const triples = [
    ['Ada Lovelace', 'works_on', 'Helios Search'],
    ['Ada Lovelace', 'reports_to', 'Alan Turing'],
    ['Grace Hopper', 'works_on', 'Memory Lifecycle'],
    ['Grace Hopper', 'reports_to', 'Alan Turing'],
    ['Grace Hopper', 'mentors', 'Katherine Johnson'],
    ['Katherine Johnson', 'works_on', 'Helios Search'],
    ['Katherine Johnson', 'owns', 'Eval Harness'],
    ['Alan Turing', 'sponsors', 'Agent Mesh'],
    ['Helios Search', 'depends_on', 'Memory Lifecycle'],
    ['Agent Mesh', 'depends_on', 'Memory Lifecycle'],
    ['Helios Search', 'decided_by', 'Adopt Hybrid Retrieval'],
    ['Memory Lifecycle', 'decided_by', 'Heat Decay Half-Life'],
    ['Agent Mesh', 'decided_by', 'One Writer Brain Vault'],
  ];
  for (const [s, p, o] of triples) {
    await tool('kg_add', { subject: s, predicate: p, object: o, confidence: 0.9, source: 'demo/seed.mjs' });
  }

  // ── Tasks ───────────────────────────────────────────────────────────────────
  const tasks = [
    ['Ship hybrid search behind a flag', 'Roll out RRF (0.6/0.4) on Helios Search guarded by a feature flag; watch eval dashboard.', 'Ada Lovelace', 'Projects/Helios Search.md'],
    ['Freeze single-writer write path', 'Stabilize the brain-vault write path so Agent Mesh can build on it.', 'Grace Hopper', 'Projects/Memory Lifecycle.md'],
    ['Backfill embeddings for archived notes', 'Embed the cold tail so semantic recall covers archived context.', 'Katherine Johnson', 'Projects/Helios Search.md'],
  ];
  for (const [title, description, owner, projectPath] of tasks) {
    await tool('tasks_create_or_update', { title, description, owner, projectPath });
  }

  // ── Journal (vault-wide ops log) ─────────────────────────────────────────────
  const journal = [
    'Shipped hybrid retrieval behind a flag on [[Projects/Helios Search.md]] — RRF 0.6/0.4.',
    'Eval harness flagged + we reverted a reranker latency regression. Owner [[CRM/People/Katherine Johnson.md]].',
    'Landed [[Decisions/Heat Decay Half-Life.md]] (14-day half-life) into [[Projects/Memory Lifecycle.md]].',
    'Kickoff for [[Projects/Agent Mesh.md]] scheduled after the write-path freeze.',
  ];
  for (const entry of journal) await tool('journal_append', { entry, source: { kind: 'manual' }, tags: ['demo'] });

  // ── Agent diaries (per-agent session recaps) ─────────────────────────────────
  await tool('diary_write', { agentName: 'claude-code', topic: 'Search rollout',
    entry: 'Implemented the RRF weighting flag for [[Projects/Helios Search.md]] and wired the eval gate. Paired with [[CRM/People/Ada Lovelace.md]].', tags: ['search'] });
  await tool('diary_write', { agentName: 'claude-code', topic: 'Lifecycle',
    entry: 'Reviewed the 14-day decay change; archived the cold tail dry-run looked safe. See [[Projects/Memory Lifecycle.md]].', tags: ['memory'] });
  await tool('diary_write', { agentName: 'cursor', topic: 'Agent Mesh spike',
    entry: 'Prototyped two agents sharing one brain vault over MCP. Reads/writes were consistent. Notes in [[Projects/Agent Mesh.md]].', tags: ['agents'] });

  // ── Entity registry (populates the Intelligence "Entity Intelligence" panel) ─
  // minConfidence 0.5 catches the wiki-linked people/projects/decisions; the
  // default 0.7 is tuned for noisier prose and finds little in terse notes.
  await tool('entity_rebuild', { seedKg: true, minConfidence: 0.5 });

  // ── Code navigation: register + index this repo ──────────────────────────────
  console.log('\nRegistering + indexing repo for code-nav (this can take a moment)…');
  await tool('code_repo_register', { path: REPO_PATH, slug: 'cortexmd' });
  await tool('code_index_repo', { repo: 'cortexmd' });

  // ── Drive code-nav queries so the Code tab shows real token-savings ──────────
  // Each cheap symbol lookup stands in for a whole-file read an agent would
  // otherwise do — that delta is what the "tokens saved" counters track.
  let ids = [];
  for (const q of ['register', 'dashboard', 'memory', 'dream', 'search', 'index repo']) {
    const r = await toolJson('code_symbol_search', { query: q, repo: 'cortexmd', limit: 8 });
    for (const sym of r?.results ?? []) if (sym.id) ids.push(sym.id);
  }
  for (const id of [...new Set(ids)].slice(0, 12)) {
    await tool('code_full_context', { id, max_body_lines: 60 });
    await tool('code_symbol_callers', { id });
  }

  // ── Searches/recalls so Overview shows live tool traffic + latencies ─────────
  for (const q of ['hybrid retrieval', 'memory decay', 'agent mesh', 'rerank latency']) {
    await tool('notes_search', { query: q, limit: 5 });
    await tool('memory_recall', { query: q, limit: 5 });
  }

  // ── Dream cycle (Intelligence tab: themes, orphans, connections, health) ─────
  await dashboardDream();

  const stats = await toolJson('code_nav_stats', {});
  console.log('\n\nSeed complete.');
  if (stats?.db) {
    console.log(`Code-nav: ${stats.db.symbolCount} symbols, ${stats.db.fileCount} files across ${stats.db.repoCount} repo(s).`);
  }
}

main().catch((err) => { console.error('\nSeed failed:', err); process.exit(1); });
