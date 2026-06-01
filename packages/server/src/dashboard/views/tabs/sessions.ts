/**
 * Sessions tab — server-rendered HTML fragment for #tab-sessions.
 *
 * Revamped to the new design system (REVAMP.md §5 TAB 2). The legacy single raw
 * table is reframed as a fleet console: a 3-tile header summary strip
 * (active-vs-idle, request concentration, fleet tool mix) answers "is the load
 * healthy and where is it concentrated?" before the per-session detail table.
 *
 * Data source is unchanged — `assets/tabs/sessions.js` fills everything from
 * `ctx.data.sessions` (+ `ctx.data.derived`) over SSE. The detail table keeps
 * its `#sessionsTableBody` id and the same columns so the kill action and SSE
 * contract are preserved; only the cell vocabulary is upgraded (idle dot,
 * tool-chip recency sequence, top-tool sparbar).
 */
import { kpi, sectionHead, statusPill } from '../components.js';

export function renderSessionsTab(): string {
  // ── Header summary strip — three KPI tiles ────────────────────────────────
  const strip = `
  <div class="grid">
    <div class="col-4">${kpi({
      label: 'Active / Idle',
      valueId: 'sessActiveVal', value: '—',
      subId: 'sessActiveSub', pillId: 'sessActivePill',
      body: `<div class="stacked-bar stacked-bar--sm" id="sessActiveBar" role="img" aria-label="Active vs idle sessions"></div>`,
    })}</div>
    <div class="col-4">${kpi({
      label: 'Request Concentration',
      valueId: 'sessConcVal', value: '—',
      subId: 'sessConcSub', pillId: 'sessConcPill',
      body: `<div class="cat-row" style="margin-top:.5rem"><div class="cat-bar-wrap"><div class="cat-bar" id="sessConcBar" style="width:0%"></div></div></div>`,
    })}</div>
    <div class="col-4">${kpi({
      label: 'Fleet Tool Mix',
      valueId: 'sessMixVal', value: '—',
      subId: 'sessMixSub',
      body: `<div class="stacked-bar stacked-bar--sm" id="sessMixBar" role="img" aria-label="Fleet tool usage mix"></div>
             <div class="chart-legend" id="sessMixLegend"></div>`,
    })}</div>
  </div>`;

  // ── "So what?" one-liner (filled client-side) ─────────────────────────────
  const soWhat = `<div class="sowhat" id="sessSoWhat"></div>`;

  // ── Per-session detail table (ids + columns preserved) ────────────────────
  const table = `
  <div class="grid">
    <div class="col-12 card">
      ${sectionHead('Active Sessions', statusPill('live', 'muted', { dot: false }))}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>IP</th>
              <th>Client</th>
              <th>Created</th>
              <th>Idle</th>
              <th class="num">Requests</th>
              <th>Recent Tools</th>
              <th>Top Tools</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="sessionsTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>`;

  return strip + soWhat + table;
}
