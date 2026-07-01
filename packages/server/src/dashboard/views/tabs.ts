/**
 * TAB registry — the single ordered list the layout, tab-bar, and (mirrored)
 * client core all derive from. Adding a tab = add a TabDef here + a
 * `views/tabs/<id>.ts` fragment + an `assets/tabs/<id>.js` module registered in
 * `app.js`. No other file changes. See ARCHITECTURE.md §4.
 */
import { renderOverviewTab } from './tabs/overview.js';
import { renderSessionsTab } from './tabs/sessions.js';
import { renderRateLimitsTab } from './tabs/ratelimits.js';
import { renderVaultTab } from './tabs/vault.js';
import { renderRetrievalTab } from './tabs/retrieval.js';
import { renderIntelligenceTab } from './tabs/intelligence.js';
import { renderGraphTab } from './tabs/graph.js';
import { renderAgentsTab } from './tabs/agents.js';
import { renderCodeTab } from './tabs/code.js';
import { renderLogsTab } from './tabs/logs.js';
import { renderOAuthTab } from './tabs/oauth.js';

export type TabId =
  | 'overview' | 'sessions' | 'ratelimits' | 'oauth' | 'vault'
  | 'retrieval' | 'intelligence' | 'graph' | 'agents' | 'code' | 'logs';

/** Visual cluster a tab belongs to (REVAMP.md §4). Does NOT affect the SSE/tab contract. */
export type TabGroup = 'ops' | 'knowledge' | 'build';

export interface TabDef {
  id: TabId;
  /** Tab-bar text, e.g. 'Vault & Memory'. */
  label: string;
  /** Visual cluster (Operations / Knowledge / Build). Tab-bar grouping only. */
  group: TabGroup;
  /** Server-rendered HTML fragment for #tab-<id> (no panel wrapper). */
  render(): string;
}

export const TABS: readonly TabDef[] = [
  { id: 'overview',     label: 'Overview',       group: 'ops',       render: renderOverviewTab },
  { id: 'sessions',     label: 'Sessions',       group: 'ops',       render: renderSessionsTab },
  { id: 'ratelimits',   label: 'Rate Limits',    group: 'ops',       render: renderRateLimitsTab },
  { id: 'oauth',        label: 'OAuth Clients',  group: 'ops',       render: renderOAuthTab },
  { id: 'logs',         label: 'Logs',           group: 'ops',       render: renderLogsTab },
  { id: 'vault',        label: 'Vault & Memory', group: 'knowledge', render: renderVaultTab },
  { id: 'retrieval',    label: 'Retrieval',      group: 'knowledge', render: renderRetrievalTab },
  { id: 'intelligence', label: 'Intelligence',   group: 'knowledge', render: renderIntelligenceTab },
  { id: 'graph',        label: 'Graph',          group: 'knowledge', render: renderGraphTab },
  { id: 'agents',       label: 'Agents',         group: 'build',     render: renderAgentsTab },
  { id: 'code',         label: 'Code',           group: 'build',     render: renderCodeTab },
] as const;

/** Human label for each cluster caption, in render order. */
export const TAB_GROUP_LABELS: Record<TabGroup, string> = {
  ops: 'Operations',
  knowledge: 'Knowledge',
  build: 'Build',
};
