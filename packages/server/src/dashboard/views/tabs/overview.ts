/**
 * Overview tab — server-rendered HTML fragment for #tab-overview.
 *
 * REFERENCE IMPLEMENTATION: this is the fully-migrated tab the other 7 copy.
 * The markup is lifted verbatim from the legacy `dashboard.ts` (the block
 * between `<!-- ====== TAB 1: Overview ====== -->` and the next tab comment),
 * minus the outer `<div id="tab-overview" class="tab-panel">` wrapper which the
 * layout now supplies. Fragment is static (no user data); the client module
 * `assets/tabs/overview.js` fills the dynamic ids over SSE.
 */
export function renderOverviewTab(): string {
  return `
  <div class="row row-4">
    <div class="card card--accent">
      <div class="card-label">MCP Requests</div>
      <div class="card-value" id="mcpRequests">0</div>
      <div class="card-sub"><span id="rpm">0</span> req/min</div>
      <div class="card-sub" id="requestBreakdown" style="margin-top:.25rem;font-size:.65rem;color:var(--text-dim)"></div>
    </div>
    <div class="card card--accent">
      <div class="card-label">Active Sessions</div>
      <div class="card-value" id="activeSessions">0</div>
    </div>
    <div class="card card--accent">
      <div class="card-label">Indexed Notes</div>
      <div class="card-value" id="indexedNotes">0</div>
    </div>
    <div class="card card--accent">
      <div class="card-label">Error Responses</div>
      <div class="card-value" id="errorRate">0</div>
      <div class="card-sub" id="errorPct" style="font-size:.75rem"></div>
    </div>
  </div>

  <div class="row row-4">
    <div class="card">
      <div class="card-label">Log: Errors</div>
      <div class="card-value" id="logErrorCount" style="color:var(--red)">0</div>
    </div>
    <div class="card">
      <div class="card-label">Log: Warnings</div>
      <div class="card-value" id="logWarnCount" style="color:var(--yellow)">0</div>
    </div>
    <div class="card">
      <div class="card-label">Log: Info</div>
      <div class="card-value" id="logInfoCount" style="color:var(--blue)">0</div>
    </div>
    <div class="card">
      <div class="card-label">Embedding Status</div>
      <div class="card-value" id="ovEmbStatus" style="font-size:1.1rem">&mdash;</div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Requests / min</div>
      <div class="chart-wrap"><svg id="chartRpm" viewBox="0 0 600 140" preserveAspectRatio="none"></svg></div>
    </div>
    <div class="card">
      <div class="section-title">Avg Latency (ms)</div>
      <div class="chart-wrap"><svg id="chartLatency" viewBox="0 0 600 140" preserveAspectRatio="none"></svg></div>
    </div>
  </div>

  <div class="row row-1">
    <div class="card">
      <div class="section-title">Tool Usage</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-col="name">Tool <span class="sort-arrow"></span></th>
              <th data-col="count">Calls <span class="sort-arrow"></span></th>
              <th data-col="avg">Avg Latency <span class="sort-arrow"></span></th>
              <th data-col="p95">P95 Latency <span class="sort-arrow"></span></th>
              <th data-col="max">Max Latency <span class="sort-arrow"></span></th>
              <th data-col="errors">Errors <span class="sort-arrow"></span></th>
              <th data-col="last">Last Called <span class="sort-arrow"></span></th>
            </tr>
          </thead>
          <tbody id="toolTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>`;
}
