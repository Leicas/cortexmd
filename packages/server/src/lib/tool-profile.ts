import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';

/**
 * Tool profile membership. Every tool is ALWAYS registered and enabled; a
 * profile only decides which tools are advertised by `tools/list`. Hidden
 * tools stay callable (the agent discovers them with `tool_search`, which reads
 * the full registry snapshot taken in tool-meta.ts) — so a reduced profile is
 * a lazy-loading surface, not a permission boundary.
 *
 * Sizes:
 *   tiny  = 6 tools
 *   nav   = 14
 *   core  = 38 (opt-in via OBSIDIAN_TOOL_PROFILE; includes the 7 CLI/hook dependencies)
 *   lean  = core + 20
 *   full  = everything
 */
export type ToolProfile = 'tiny' | 'nav' | 'core' | 'lean' | 'full';

const TINY: ReadonlyArray<string> = [
  'notes_search',
  'memory_recall',
  'memory_store',
  'code_symbol_search',
  'code_file_outline',
  'tool_search',
];

const NAV_EXTRAS: ReadonlyArray<string> = [
  'code_symbol_get',
  'code_symbol_callers',
  'code_symbol_callees',
  'code_change_impact',
  'code_full_context',
  'code_audit_file',
  'code_repo_list',
  'code_project_symbol',
];

const CORE_EXTRAS: ReadonlyArray<string> = [
  'memory_consolidate',
  'memory_wakeup',
  'memory_dream',
  'memory_promote',
  'notes_get',
  'notes_list',
  'notes_upsert',
  'notes_archive',
  'journal_append',
  'brief_daily',
  'agent_diary_append',
  'agent_diary_read',
  'graph_neighbors',
  'graph_traverse',
  'graph_stats',
  'tags_list',
  'check_duplicate',
  // CLI / hook dependencies (cortexmd status, hud-line, code-index, wakeup
  // directive) — these must be advertised by the default profile.
  'kg_query',
  'diary_write',
  'diary_read',
  'code_index_repo',
  'code_ingest_repo',
  'code_index_requests_poll',
  'code_savings_push',
];

const LEAN_EXTRAS: ReadonlyArray<string> = [
  // notes management
  'notes_link_entities',
  'notes_categorize',
  'notes_delete',
  // tasks
  'tasks_create_or_update',
  'tasks_resolve',
  // memory expansion
  'memory_temperature_refresh',
  'memory_consolidate_series',
  // KG
  'kg_add',
  'kg_timeline',
  'kg_stats',
  // graph hygiene
  'graph_orphans',
  'graph_broken_links',
  'graph_bridges',
  // tags
  'tags_singletons',
  'tags_merge',
  // entity / dedup
  'entity_detect',
  // code-nav extras
  'code_check_staleness',
  'code_repo_register',
  // reasoning traces
  'reasoning_save',
  'reasoning_search',
];

function compose(...lists: ReadonlyArray<ReadonlyArray<string>>): Set<string> {
  const out = new Set<string>();
  for (const l of lists) for (const n of l) out.add(n);
  return out;
}

const PROFILE_SETS: Record<Exclude<ToolProfile, 'full'>, Set<string>> = {
  tiny: compose(TINY),
  nav: compose(TINY, NAV_EXTRAS),
  core: compose(TINY, NAV_EXTRAS, CORE_EXTRAS),
  lean: compose(TINY, NAV_EXTRAS, CORE_EXTRAS, LEAN_EXTRAS),
};

const VALID: ReadonlySet<string> = new Set(['tiny', 'nav', 'core', 'lean', 'full']);

export const DEFAULT_TOOL_PROFILE: ToolProfile = 'full';

/**
 * Resolve the profile name. `full` is the default: every tool is advertised.
 * Reduced profiles (`tiny`/`nav`/`core`/`lean`) only trim what `tools/list`
 * advertises — hidden tools stay registered and callable for raw MCP clients
 * and `tool_search`, but note that Claude Code / ChatGPT / Codex only call
 * tools they saw in `tools/list`, so a reduced profile is an explicit opt-in
 * (`OBSIDIAN_TOOL_PROFILE=core`) for token-sensitive deployments.
 */
export function parseToolProfile(raw: string | undefined | null): ToolProfile {
  const v = (raw ?? '').toLowerCase().trim();
  if (VALID.has(v)) return v as ToolProfile;
  return DEFAULT_TOOL_PROFILE;
}

export function profileMembership(profile: ToolProfile): ReadonlySet<string> | null {
  if (profile === 'full') return null;
  return PROFILE_SETS[profile];
}

/** Sorted tool names a profile advertises (null for `full` = everything). */
export function profileToolNames(profile: ToolProfile): string[] | null {
  const set = profileMembership(profile);
  return set ? [...set].sort() : null;
}

export interface ToolProfileResult {
  profile: ToolProfile;
  /** Tools advertised by tools/list. */
  kept: number;
  /** Registered but not advertised (still callable). */
  hidden: number;
  /** Always 0 — kept for callers that read the old shape. */
  disabled: 0;
}

interface ListToolsResult {
  tools: Array<{ name: string } & Record<string, unknown>>;
  [key: string]: unknown;
}

type RawHandler = (request: unknown, extra: unknown) => Promise<unknown>;

/**
 * Apply a profile WITHOUT disabling anything: every tool stays `enabled` (so
 * the SDK dispatches `tools/call` for it) and the server's `tools/list`
 * handler is wrapped to advertise only the profile's members.
 *
 * The SDK installs its own `tools/list` handler on the first `server.tool()`
 * registration; we fetch that wrapped handler from the protocol's handler map,
 * then re-register under the same method so the original still builds the
 * JSON-Schema tool definitions and we only filter the array. If the handler
 * map is unreachable (SDK internals moved), we log and advertise everything —
 * never fail startup.
 */
export function applyToolProfile(server: unknown, profile: ToolProfile): ToolProfileResult {
  const allowed = profileMembership(profile);
  const mcp = server as {
    _registeredTools?: Record<string, { enabled: boolean }>;
    server?: {
      setRequestHandler?: (schema: unknown, handler: RawHandler) => void;
      _requestHandlers?: Map<string, RawHandler>;
    };
  };
  const reg = mcp._registeredTools;
  const total = reg ? Object.keys(reg).length : 0;

  // Never leave a tool disabled (older builds flipped `enabled=false`).
  if (reg) for (const tool of Object.values(reg)) tool.enabled = true;

  if (!allowed || total === 0) {
    return { profile, kept: total, hidden: 0, disabled: 0 };
  }

  const inner = mcp.server;
  const original = inner?._requestHandlers?.get('tools/list');
  if (!inner || typeof inner.setRequestHandler !== 'function' || typeof original !== 'function') {
    logger.warn('Tool profile: tools/list handler not found — advertising every tool', { profile });
    return { profile, kept: total, hidden: 0, disabled: 0 };
  }

  inner.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = (await original(request, extra)) as ListToolsResult;
    if (!result || !Array.isArray(result.tools)) return result;
    return { ...result, tools: result.tools.filter((t) => allowed.has(t.name)) };
  });

  let kept = 0;
  for (const name of Object.keys(reg!)) if (allowed.has(name)) kept++;
  const hidden = total - kept;
  logger.info('Applied tool profile', { profile, kept, hidden, total });
  return { profile, kept, hidden, disabled: 0 };
}
