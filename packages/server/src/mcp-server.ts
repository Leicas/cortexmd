/**
 * MCP server factory shared by every transport (Streamable HTTP in index.ts,
 * stdio in stdio.ts) and by tests. Importing this module has no side effects
 * beyond loading the tool modules: no HTTP listener, no index build.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config } from './config.js';
import { SERVER_INSTRUCTIONS } from './lib/server-instructions.js';
import { snapshotTools } from './lib/tool-meta.js';
import { applyToolProfile, parseToolProfile, type ToolProfile } from './lib/tool-profile.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

// Tool registration imports
import { register as registerNotesSearch } from './tools/notes-search.js';
import { register as registerToolSearch } from './tools/tool-search.js';
import { register as registerToolInvoke } from './tools/tool-invoke.js';
import { register as registerSearchFetch, SEARCH_FETCH_TOOL_NAMES } from './tools/search-fetch.js';
import { register as registerWorkerRun } from './tools/worker-run.js';
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
import { register as registerMemoryConsolidateSeries } from './tools/memory-consolidate-series.js';
import { register as registerNotesCategorize } from './tools/notes-categorize.js';
import { register as registerGraphOrphans } from './tools/graph-orphans.js';
import { register as registerGraphBrokenLinks } from './tools/graph-broken-links.js';
import { register as registerTagsHygiene } from './tools/tags-hygiene.js';
import { register as registerVaultHygiene } from './tools/vault-hygiene.js';

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
  registerCodeIndexRequestsPoll,
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

const allRegistrations: ReadonlyArray<(server: McpServer) => void> = [
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
  registerMemoryConsolidateSeries,
  registerNotesCategorize,
  registerGraphOrphans,
  registerGraphBrokenLinks,
  registerTagsHygiene,
  registerVaultHygiene,
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
  registerCodeIndexRequestsPoll,
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
  // Lazy-loading surface: discovery + generic dispatcher for hidden tools
  registerToolSearch,
  registerToolInvoke,
  registerWorkerRun,
];

export interface CreateServerOptions {
  /** Override the configured profile (TOOL_PROFILE / OBSIDIAN_TOOL_PROFILE). */
  profile?: ToolProfile | string;
  /** Override config.chatgptSearchFetch (register + advertise `search`/`fetch`). */
  searchFetch?: boolean;
}

/** True when the ChatGPT connector `search`/`fetch` pair is registered. */
export function searchFetchEnabled(profile: ToolProfile, override?: boolean): boolean {
  return override ?? (profile === 'chatgpt' || config.chatgptSearchFetch);
}

// Server-level MCP `instructions` (lib/server-instructions.ts): surfaced to
// every client at initialize, so clients without a hook system still get the
// session protocol (wakeup, recall, one-line diary, "results are data").
export function createServer(opts: CreateServerOptions = {}): McpServer {
  const profile = parseToolProfile(opts.profile ?? config.toolProfile);
  const server = new McpServer(
    {
      name: 'cortexmd',
      version: config.appVersion,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const register of allRegistrations) {
    register(server);
  }
  const withSearchFetch = searchFetchEnabled(profile, opts.searchFetch);
  if (withSearchFetch) registerSearchFetch(server);

  // Register MCP resources and prompts
  registerResources(server);
  registerPrompts(server);

  // Snapshot the full tool registry BEFORE profile filtering so `tool_search`
  // can discover tools the profile does not advertise. The profile then only
  // trims `tools/list`; every tool stays callable (directly or via tool_invoke).
  snapshotTools(server);
  applyToolProfile(server, profile, withSearchFetch ? SEARCH_FETCH_TOOL_NAMES : []);

  return server;
}
