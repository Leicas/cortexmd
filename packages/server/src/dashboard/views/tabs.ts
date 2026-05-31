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
import { renderIntelligenceTab } from './tabs/intelligence.js';
import { renderAgentsTab } from './tabs/agents.js';
import { renderCodeTab } from './tabs/code.js';
import { renderLogsTab } from './tabs/logs.js';

export type TabId =
  | 'overview' | 'sessions' | 'ratelimits' | 'vault'
  | 'intelligence' | 'agents' | 'code' | 'logs';

export interface TabDef {
  id: TabId;
  /** Tab-bar text, e.g. 'Vault & Memory'. */
  label: string;
  /** Server-rendered HTML fragment for #tab-<id> (no panel wrapper). */
  render(): string;
}

export const TABS: readonly TabDef[] = [
  { id: 'overview',     label: 'Overview',       render: renderOverviewTab },
  { id: 'sessions',     label: 'Sessions',       render: renderSessionsTab },
  { id: 'ratelimits',   label: 'Rate Limits',    render: renderRateLimitsTab },
  { id: 'vault',        label: 'Vault & Memory', render: renderVaultTab },
  { id: 'intelligence', label: 'Intelligence',   render: renderIntelligenceTab },
  { id: 'agents',       label: 'Agents',         render: renderAgentsTab },
  { id: 'code',         label: 'Code',           render: renderCodeTab },
  { id: 'logs',         label: 'Logs',           render: renderLogsTab },
] as const;
