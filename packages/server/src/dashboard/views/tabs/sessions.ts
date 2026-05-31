/**
 * Sessions tab — server-rendered HTML fragment for #tab-sessions.
 *
 * Markup lifted verbatim from the legacy `dashboard.ts` (the block between
 * `<!-- ====== TAB 2: Sessions ====== -->` and the next tab comment), minus the
 * outer `<div id="tab-sessions" class="tab-panel">` wrapper which the layout now
 * supplies. Fragment is static (no user data); the client module
 * `assets/tabs/sessions.js` fills `#sessionsTableBody` over SSE.
 */
export function renderSessionsTab(): string {
  return `
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Active Sessions</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session ID</th>
              <th>IP</th>
              <th>Client</th>
              <th>Created</th>
              <th>Last Activity</th>
              <th>Requests</th>
              <th>Recent Tools</th>
              <th>Tool Breakdown</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="sessionsTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>`;
}
