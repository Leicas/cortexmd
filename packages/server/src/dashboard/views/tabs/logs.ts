/**
 * Logs tab — server-rendered HTML fragment for #tab-logs.
 *
 * Revamped to the design system (REVAMP.md §5 TAB 8): a header **summary strip**
 * of KPI tiles (errors/min, tool success rate, top error signature, auth
 * failures/min) sits above the existing feeds, so a spike/recurring-signature is
 * visible at a glance instead of being buried in a scrolling feed. The feeds
 * themselves are preserved verbatim as drill-down — same ids
 * (`systemLogsFeed`, `logToolCalls`, `logErrors`, `authFailuresTableBody`),
 * same filter controls (`logFilterSource/Text/Debug/Info/Warn/Error`), same
 * behavior — so `assets/tabs/logs.js` keeps its data source untouched.
 *
 * Built from the shared component vocabulary (`kpi`, `statusPill`, `sectionHead`)
 * + tokens; no ad-hoc styles. Dynamic values (KPIs, sparklines, feeds) are filled
 * client-side over SSE by the logs client module.
 */
import { kpi } from '../components.js';

export function renderLogsTab(): string {
  // ── Band A — Summary strip (4 KPI tiles) ────────────────────────────────────
  // Each tile exposes stable ids the client fills from ctx.data (+ derived):
  //  - errors/min      → drawBars over recentErrors + error-level systemLogs
  //  - tool success    → rolling ok/error over recentToolCalls[].status
  //  - top signature   → grouped recentErrors/error tool-calls ("1 problem ×N")
  //  - auth fails/min  → derived.authFailPerMin (shared with Rate Limits)
  const strip = `
  <div class="grid">
    <div class="col-3">${kpi({
      label: 'Errors / min', valueId: 'logErrPerMin', value: '0',
      subId: 'logErrPerMinSub', pillId: 'logErrPill', sparkId: 'logErrSpark',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Tool Success Rate', valueId: 'logSuccessRate', value: '—',
      subId: 'logSuccessSub', pillId: 'logSuccessPill',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Top Error Signature', valueId: 'logTopErr', value: '—', mono: true,
      subId: 'logTopErrSub',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Auth Failures / min', valueId: 'logAuthPerMin', value: '0',
      subId: 'logAuthSub', pillId: 'logAuthPill', sparkId: 'logAuthSpark',
      linkTab: 'ratelimits',
    })}</div>
  </div>
  <div class="sowhat" id="logsSoWhat"></div>`;

  // ── Band B — System logs feed (filterable; primary drill-down) ──────────────
  const systemLogs = `
  <div class="grid">
    <div class="col-12 card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">System Logs</div>
        <div class="section-head-actions">
          <select id="logFilterSource" class="select" style="width:auto" aria-label="Filter by module">
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
          <input id="logFilterText" type="text" class="input mono" placeholder="Filter text…" style="width:150px" aria-label="Filter log text">
          <div role="group" aria-label="Log level filters" style="display:flex;gap:.6rem;align-items:center;font:600 var(--fs-xs)/1 var(--mono)">
            <label style="display:inline-flex;align-items:center;gap:.25rem;color:var(--text-dim);cursor:pointer"><input type="checkbox" id="logFilterDebug"> dbg</label>
            <label style="display:inline-flex;align-items:center;gap:.25rem;color:var(--info);cursor:pointer"><input type="checkbox" id="logFilterInfo" checked> info</label>
            <label style="display:inline-flex;align-items:center;gap:.25rem;color:var(--warn);cursor:pointer"><input type="checkbox" id="logFilterWarn" checked> warn</label>
            <label style="display:inline-flex;align-items:center;gap:.25rem;color:var(--err);cursor:pointer"><input type="checkbox" id="logFilterError" checked> err</label>
          </div>
        </div>
      </div>
      <div class="feed" id="systemLogsFeed" style="max-height:480px;background:var(--bg-elev);box-shadow:var(--inset-well);border-radius:var(--r-sm);padding:.4rem .5rem"><div class="empty-msg">No logs captured.</div></div>
    </div>
  </div>`;

  // ── Band C — Tool calls + Recent errors (col-7 / col-5 split) ───────────────
  const callsAndErrors = `
  <div class="grid">
    <div class="col-7 card">
      <div class="section-title">Recent Tool Calls</div>
      <div class="feed" id="logToolCalls"><div class="empty-msg">No tool calls recorded.</div></div>
    </div>
    <div class="col-5 card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Recent Errors</div>
        <span class="badge badge--err" id="logErrCount" style="display:none"></span>
      </div>
      <div id="logErrors"><div class="empty-msg">No errors recorded.</div></div>
    </div>
  </div>`;

  // ── Band D — Auth failures table (security drill-down) ──────────────────────
  const authFailures = `
  <div class="grid">
    <div class="col-12 card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Auth Failures</div>
        <span class="badge badge--warn" id="logAuthCount" style="display:none"></span>
      </div>
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

  return strip + systemLogs + callsAndErrors + authFailures;
}
