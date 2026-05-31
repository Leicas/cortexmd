import { logger } from './logger.js';

/**
 * Tool profile membership. The default `full` profile registers every tool;
 * smaller profiles disable tools after registration so they're not advertised
 * via tools/list. Disabled tools remain visible to `tool_search` so an agent
 * can discover them, but cannot be invoked unless they're re-enabled.
 *
 * Aligns with token-savior v2.9.0 profile sizes:
 *   tiny  ≈ 6 tools
 *   nav   ≈ 12
 *   core  ≈ 29
 *   lean  ≈ 50
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
];

const LEAN_EXTRAS: ReadonlyArray<string> = [
  // notes management
  'notes_link_entities',
  'notes_categorize',
  'notes_delete',
  // tasks + diary expansion
  'tasks_create_or_update',
  'tasks_resolve',
  'diary_write',
  'diary_read',
  // memory expansion
  'memory_temperature_refresh',
  'memory_consolidate_series',
  // KG
  'kg_query',
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

export function parseToolProfile(raw: string | undefined | null): ToolProfile {
  const v = (raw ?? '').toLowerCase().trim();
  if (VALID.has(v)) return v as ToolProfile;
  return 'full';
}

export function profileMembership(profile: ToolProfile): ReadonlySet<string> | null {
  if (profile === 'full') return null;
  return PROFILE_SETS[profile];
}

/**
 * Disable any tool not in the requested profile. Tools are still registered
 * (so tool_search can find them) but `tools/list` filters them out, and the
 * SDK rejects invocation. Uses `_registeredTools[name].enabled = false`,
 * which the MCP SDK honors at both list and dispatch.
 *
 * Returns the kept count so the startup banner can show what was loaded.
 */
export function applyToolProfile(server: unknown, profile: ToolProfile): { kept: number; disabled: number; profile: ToolProfile } {
  const allowed = profileMembership(profile);
  const reg = (server as { _registeredTools?: Record<string, { enabled: boolean }> })._registeredTools;
  if (!reg) return { kept: 0, disabled: 0, profile };

  const total = Object.keys(reg).length;
  if (!allowed) {
    return { kept: total, disabled: 0, profile };
  }

  let disabled = 0;
  for (const [name, tool] of Object.entries(reg)) {
    if (!allowed.has(name)) {
      tool.enabled = false;
      disabled++;
    }
  }

  const kept = total - disabled;
  logger.info('Applied tool profile', { profile, kept, disabled, total });
  return { kept, disabled, profile };
}
