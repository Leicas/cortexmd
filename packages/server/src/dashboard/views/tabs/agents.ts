/**
 * Agents tab — server-rendered HTML fragment for #tab-agents.
 *
 * Revamped to the design system (REVAMP.md §5 TAB 6): an activity-summary strip
 * of KPI tiles + a "most active agents" ranking card sit ABOVE the three roster
 * tables (agents / teams / skills) which remain reference data, and the diary
 * renders as a timeline feed. The roster (agents/teams/skills) is fetched once
 * over /dashboard/api/{agents,teams,skills}; activity signals are derived
 * CLIENT-SIDE from `ctx.data.agentDiaries` (the only agents data in the SSE
 * payload) joined with that roster — `model/derive.ts` is a shared file and is
 * intentionally not extended here.
 *
 * Every legacy id the client writes is preserved verbatim: agCountAgents,
 * agCountTeams, agCountSkills, agentsTableBody, teamsTableBody, skillsTableBody,
 * diaryAgentSelect, diaryLimitSelect, diaryBody. New ids (agActive24h, agBusiest,
 * agDormant, agNeverRun, agRankBars, agSoWhat) are additive. Built from the
 * shared components in views/components.ts so the tile vocabulary stays
 * consistent with Overview.
 */
import { kpi, sectionHead, emptyState } from '../components.js';

export function renderAgentsTab(): string {
  // ── Activity summary strip (REVAMP.md §5 TAB 6) ───────────────────────────
  // Three glanceable KPIs answering "is the agent fleet alive, who's busiest,
  // and what's misconfigured?" — all filled by assets/tabs/agents.js.
  const summary = `
  <div class="grid">
    <div class="col-4">${kpi({
      label: 'Active Agents (24h)', valueId: 'agActive24h', value: '0',
      subId: 'agActive24hSub', pillId: 'agActivePill',
    })}</div>
    <div class="col-4">${kpi({
      label: 'Busiest Agent', valueId: 'agBusiest', value: '—', mono: true,
      subId: 'agBusiestSub',
    })}</div>
    <div class="col-4">${kpi({
      label: 'Never Run', valueId: 'agNeverRun', value: '0',
      subId: 'agNeverRunSub', pillId: 'agNeverRunPill',
    })}</div>
  </div>`;

  // ── "Most active agents" ranking + so-what ────────────────────────────────
  const ranking = `
  <div class="grid">
    <div class="col-12 card">
      ${sectionHead('Most Active Agents', '<span class="card-sub" style="margin:0">by diary entries</span>')}
      <div id="agRankBars">
        <div class="skel skel--line" aria-hidden="true"></div>
        <div class="skel skel--line" aria-hidden="true"></div>
        <div class="skel skel--line" aria-hidden="true"></div>
      </div>
    </div>
  </div>
  <div class="sowhat" id="agSoWhat"></div>`;

  // ── Roster tables (reference data; ids preserved) ─────────────────────────
  const rosters = `
  <div class="grid">
    <div class="col-12 card">
      <div class="section-title">Agents</div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Name</th><th>Display</th><th>Role</th><th>Model</th><th>Tags</th><th>Path</th>
        </tr></thead>
        <tbody id="agentsTableBody"><tr>
          <td colspan="6"><div class="skel skel--line" aria-hidden="true"></div></td>
        </tr></tbody>
      </table></div>
    </div>
  </div>
  <div class="grid">
    <div class="col-12 card">
      <div class="section-title">Teams</div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Name</th><th>Display</th><th>Coordination</th><th class="num">Members</th><th>Path</th>
        </tr></thead>
        <tbody id="teamsTableBody"><tr>
          <td colspan="5"><div class="skel skel--line" aria-hidden="true"></div></td>
        </tr></tbody>
      </table></div>
    </div>
  </div>
  <div class="grid">
    <div class="col-12 card">
      <div class="section-title">Skills</div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Name</th><th>Display</th><th>Trigger</th><th>Description</th><th>Tags</th><th>Path</th>
        </tr></thead>
        <tbody id="skillsTableBody"><tr>
          <td colspan="6"><div class="skel skel--line" aria-hidden="true"></div></td>
        </tr></tbody>
      </table></div>
    </div>
  </div>`;

  // ── Agent diary (timeline feed) ───────────────────────────────────────────
  const diary = `
  <div class="grid">
    <div class="col-12 card">
      ${sectionHead('Agent Diary', `
        <select id="diaryAgentSelect" class="select" style="width:auto" aria-label="Select agent">
          <option value="">Select agent&hellip;</option>
        </select>
        <select id="diaryLimitSelect" class="select" style="width:auto" aria-label="Entry limit">
          <option value="20">Last 20</option>
          <option value="50">Last 50</option>
          <option value="200">Last 200</option>
        </select>`)}
      <div id="diaryBody" class="feed">
        ${emptyState('No agent selected', 'Choose an agent to view its recent diary entries.')}
      </div>
    </div>
  </div>`;

  return summary + ranking + rosters + diary;
}
