/**
 * Agents tab — server-rendered HTML fragment for #tab-agents.
 *
 * Markup migrated from the legacy `dashboard.ts` (the block between
 * `<!-- ====== TAB: Agents ====== -->` and the next tab comment), minus the
 * outer `<div id="tab-agents" class="tab-panel">` wrapper which the layout now
 * supplies. Inline-styled flex header / selects / scroll body are re-pointed at
 * the design's component classes (`.section-head`, `.select`, `.feed`) per the
 * UX refresh; no behavior change. Dynamic ids are filled by the client module
 * `assets/tabs/agents.js`.
 */
export function renderAgentsTab(): string {
  return `
  <div class="row row-3">
    <div class="card"><div class="card-label">Agents</div><div class="card-value mono" id="agCountAgents">0</div></div>
    <div class="card"><div class="card-label">Teams</div><div class="card-value mono" id="agCountTeams">0</div></div>
    <div class="card"><div class="card-label">Skills</div><div class="card-value mono" id="agCountSkills">0</div></div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Agents</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Display</th><th>Role</th><th>Model</th><th>Tags</th><th>Path</th></tr></thead>
        <tbody id="agentsTableBody"><tr><td colspan="6" class="empty-msg" style="text-align:center">Loading&hellip;</td></tr></tbody>
      </table></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Teams</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Display</th><th>Coordination</th><th>Members</th><th>Path</th></tr></thead>
        <tbody id="teamsTableBody"><tr><td colspan="5" class="empty-msg" style="text-align:center">Loading&hellip;</td></tr></tbody>
      </table></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Skills</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Display</th><th>Trigger</th><th>Description</th><th>Tags</th><th>Path</th></tr></thead>
        <tbody id="skillsTableBody"><tr><td colspan="6" class="empty-msg" style="text-align:center">Loading&hellip;</td></tr></tbody>
      </table></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Agent Diary</div>
        <div class="section-head-actions">
          <select id="diaryAgentSelect" class="select" style="width:auto">
            <option value="">Select agent&hellip;</option>
          </select>
          <select id="diaryLimitSelect" class="select" style="width:auto">
            <option value="20">Last 20</option>
            <option value="50">Last 50</option>
            <option value="200">Last 200</option>
          </select>
        </div>
      </div>
      <div id="diaryBody" class="feed">
        <span class="empty-msg">Select an agent to view recent diary entries.</span>
      </div>
    </div>
  </div>`;
}
