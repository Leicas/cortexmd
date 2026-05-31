/**
 * Logs tab — server-rendered HTML fragment for #tab-logs.
 *
 * Markup migrated from the legacy `dashboard.ts` (the block between
 * `<!-- ====== TAB 7: Logs ====== -->` and the next tab comment), minus the
 * outer `<div id="tab-logs" class="tab-panel">` wrapper which the layout now
 * supplies. The legacy inline-styled filter `<select>`/`<input>` and the
 * hand-rolled flex header are re-templated onto the design's component classes
 * (`.section-head`, `.select`, `.input`, `.log-filter-levels`) and tokens —
 * same ids, same options, same behavior. Fragment is static (no user data);
 * the client module `assets/tabs/logs.js` fills the dynamic feeds over SSE.
 */
export function renderLogsTab(): string {
  return `
  <div class="row row-1">
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">System Logs</div>
        <div class="section-head-actions">
          <select id="logFilterSource" class="select" style="width:auto">
            <option value="all">All modules</option>
            <option value="embeddings">embeddings</option>
            <option value="search">search</option>
            <option value="vault">vault</option>
            <option value="auth">auth</option>
            <option value="sessions">sessions</option>
            <option value="metrics">metrics</option>
            <option value="server">server</option>
            <option value="general">general</option>
          </select>
          <input id="logFilterText" type="text" class="input" placeholder="Filter text..." style="width:140px">
          <div class="section-head-actions">
            <label style="font-size:var(--fs-xs);color:var(--text-dim)"><input type="checkbox" id="logFilterDebug" style="margin-right:.2rem"> dbg</label>
            <label style="font-size:var(--fs-xs);color:var(--text)"><input type="checkbox" id="logFilterInfo" checked style="margin-right:.2rem"> info</label>
            <label style="font-size:var(--fs-xs);color:var(--yellow)"><input type="checkbox" id="logFilterWarn" checked style="margin-right:.2rem"> warn</label>
            <label style="font-size:var(--fs-xs);color:var(--red)"><input type="checkbox" id="logFilterError" checked style="margin-right:.2rem"> err</label>
          </div>
        </div>
      </div>
      <div class="feed" id="systemLogsFeed" style="max-height:500px;font-size:.75rem"><div class="empty-msg">No logs captured.</div></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title">Recent Tool Calls</div>
      <div class="feed" id="logToolCalls"><div class="empty-msg">No tool calls recorded.</div></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title" style="color:var(--red)">Recent Errors</div>
      <div id="logErrors"><div class="empty-msg">No errors recorded.</div></div>
    </div>
  </div>
  <div class="row row-1">
    <div class="card">
      <div class="section-title" style="color:var(--yellow)">Auth Failures</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>IP Address</th>
              <th>Method</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody id="authFailuresTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>`;
}
