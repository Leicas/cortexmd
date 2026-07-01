/**
 * Overview tab — server-rendered HTML fragment for #tab-overview.
 *
 * FLAGSHIP REFERENCE IMPLEMENTATION (REVAMP.md §5 TAB 1). The executive summary:
 *   Band A — System Status strip (cross-tab roll-up of "is everything up?")
 *   Band B — KPI scorecards (the 8 headline numbers; each deep-links to detail)
 *   Band C — Attention feed (only actionable/anomalous items)
 *   Band D — Operational detail (the legacy charts + Tool Usage table, demoted)
 *
 * All dynamic values are filled by `assets/tabs/overview.js` over SSE. Every id
 * the legacy client wrote (`mcpRequests`, `rpm`, `requestBreakdown`,
 * `activeSessions`, `indexedNotes`, `errorRate`, `errorPct`, `chartRpm`,
 * `chartLatency`, `toolTableBody`) is preserved. Built from the shared
 * components in views/components.ts so the tile vocabulary stays consistent.
 */
import { kpi, statusPill } from '../components.js';

export function renderOverviewTab(): string {
  // ── Band A — System Status strip ──────────────────────────────────────────
  const statusStrip = `
  <div class="grid">
    <div class="col-12 card card--pad-sm" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
      <span class="card-label" style="margin:0 .5rem 0 0">System Status</span>
      <button type="button" class="pill pill--muted" id="stMcp" onclick="window.cortex.switchTab('logs')" aria-label="MCP / SSE status">
        <span class="dot" aria-hidden="true"></span>MCP / SSE</button>
      <button type="button" class="pill pill--muted" id="stLlm" onclick="window.cortex.switchTab('intelligence')" aria-label="Local LLM status">
        <span class="dot" aria-hidden="true"></span>Local LLM</button>
      <button type="button" class="pill pill--muted" id="stEmb" onclick="window.cortex.switchTab('vault')" aria-label="Embeddings status">
        <span class="dot" aria-hidden="true"></span>Embeddings</button>
      <button type="button" class="pill pill--muted" id="stIndex" onclick="window.cortex.switchTab('vault')" aria-label="Search index status">
        <span class="dot" aria-hidden="true"></span>Search Index</button>
      <button type="button" class="pill pill--muted" id="stVault" onclick="window.cortex.switchTab('intelligence')" aria-label="Vault health status">
        <span class="dot" aria-hidden="true"></span>Vault Health</button>
    </div>
  </div>`;

  // ── Band B — KPI scorecards (two rows of four col-3 tiles) ────────────────
  const kpiRow1 = `
  <div class="grid">
    <div class="col-3">${kpi({
      label: 'MCP Requests', valueId: 'mcpRequests', value: '0',
      subId: 'requestBreakdown', deltaId: 'mcpDelta', sparkId: 'kpiRpmSpark',
      linkTab: 'logs',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Error Rate', valueId: 'errorRate', value: '0%',
      subId: 'errorPct', pillId: 'errorPill', linkTab: 'logs',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Latency Health', valueId: 'latencyVal', value: '0 ms',
      subId: 'latencyTail', pillId: 'latencyPill', sparkId: 'kpiLatSpark',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Vault Health', valueId: 'vaultHealthVal', value: '—',
      subId: 'vaultHealthSub', pillId: 'vaultHealthPill', sparkId: 'kpiHealthSpark',
      linkTab: 'intelligence',
    })}</div>
  </div>`;

  const kpiRow2 = `
  <div class="grid">
    <div class="col-3">${kpi({
      label: 'Active Sessions', valueId: 'activeSessions', value: '0',
      subId: 'sessionsSub', linkTab: 'sessions',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Memory Temperature', valueId: 'memTempVal', value: '—',
      subId: 'memTempSub', linkTab: 'vault',
      body: `<div class="stacked-bar stacked-bar--sm" id="memTempBar" role="img" aria-label="Memory temperature distribution"></div>`,
    })}</div>
    <div class="col-3">${kpi({
      label: 'Code-Nav Savings', valueId: 'savingsVal', value: '0',
      subId: 'savingsSub', sparkId: 'kpiSavingsSpark', linkTab: 'code',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Indexed Notes', valueId: 'indexedNotes', value: '0',
      subId: 'notesSub', linkTab: 'vault',
    })}</div>
  </div>`;

  // ── Band C — Attention feed (col-8 / col-4 split) ─────────────────────────
  const attention = `
  <div class="grid">
    <div class="col-8 card">
      <div class="section-head">
        <div class="section-title" style="margin:0">Needs attention</div>
        ${statusPill('live', 'muted', { dot: false })}
      </div>
      <div id="attnErrors"></div>
    </div>
    <div class="col-4 card">
      <div class="section-title">Signals</div>
      <div id="attnSignals"></div>
    </div>
  </div>`;

  // ── Band D — Operational detail (legacy ids preserved verbatim) ───────────
  // NOTE: the former `#ovSoWhat` summary strip was removed — it duplicated the
  // KPI scorecards directly above it (rpm / error rate / vault grade / sessions).
  const detail = `
  <div class="grid">
    <div class="col-6 card">
      <div class="section-title">Requests / min</div>
      <div class="chart-wrap"><svg id="chartRpm" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"></svg></div>
    </div>
    <div class="col-6 card">
      <div class="section-title">Avg Latency (ms)</div>
      <div class="chart-wrap"><svg id="chartLatency" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"></svg></div>
    </div>
  </div>

  <div class="grid">
    <div class="col-12 card">
      <div class="section-title">Tool Usage</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-col="name">Tool <span class="sort-arrow"></span></th>
              <th data-col="count" class="num">Calls <span class="sort-arrow"></span></th>
              <th data-col="avg" class="num">Avg Latency <span class="sort-arrow"></span></th>
              <th data-col="p95" class="num">P95 Latency <span class="sort-arrow"></span></th>
              <th data-col="max" class="num">Max Latency <span class="sort-arrow"></span></th>
              <th data-col="errors" class="num">Err Rate <span class="sort-arrow"></span></th>
              <th data-col="last">Last Called <span class="sort-arrow"></span></th>
              <th data-col="status">Status <span class="sort-arrow"></span></th>
            </tr>
          </thead>
          <tbody id="toolTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>`;

  return statusStrip + kpiRow1 + kpiRow2 + attention + detail;
}
