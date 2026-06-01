/**
 * Code tab — server-rendered HTML fragment for #tab-code.
 *
 * Revamped to the new design system (REVAMP.md §5 TAB 7 — "token-savings, the
 * product ROI thesis"). The flagship Overview tab is the reference; this tab
 * mirrors its band structure and the shared KPI/card/chart/empty vocabulary
 * from views/components.ts:
 *
 *   Band A — "So what?" strip (the one-line read on savings + index quality)
 *   Band B — KPI scorecards (cumulative savings + run-rate, avg/call,
 *            call-resolution gauge, index footprint) each a token-driven tile
 *   Band C — Savings analytics: real cumulative-savings area chart +
 *            by-tool Pareto bars (the ranking IS the insight)
 *   Band D — Drill-down tables: by-tool, by-repo, per-repo index health
 *
 * Data source is UNCHANGED: every dynamic id is filled by `assets/tabs/code.js`
 * over SSE from `ctx.data.codeNav`, `ctx.data.codeNavSavings`, and the shared
 * `ctx.data.derived` signals (savingsPerCall / savingsRunRate /
 * callResolutionPct). No payload/endpoint changes.
 *
 * Since this tab's view + client module are revamped together (and no shared
 * file references its ids), the markup is reorganised around the new tiles.
 * The repo/file/db raw counts that were once standalone tiles are folded into
 * the Index Footprint tile's sub-line; the previously-ASCII `codeSavingsChart`
 * id is reused as the KPI sparkline (a real `drawChart`). Retained ids:
 * codeSymbolCount, codeCallStats, codeRepoTable, codeSavingsSummary,
 * codeSavingsTable, codeSavingsRepoTable, codeSavingsChart.
 */
import { kpi } from '../components.js';

export function renderCodeTab(): string {
  // ── Band A — "So what?" one-liner ──────────────────────────────────────────
  const soWhat = `<div class="sowhat" id="codeSoWhat"></div>`;

  // ── Band B — KPI scorecards ────────────────────────────────────────────────
  const kpis = `
  <div class="grid">
    <div class="col-3">${kpi({
      label: 'Tokens Saved',
      valueId: 'codeSavingsTotal', value: '0',
      subId: 'codeSavingsSub', sub: 'no code-nav calls yet',
      deltaId: 'codeSavingsDelta', sparkId: 'codeSavingsChart',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Avg / Call',
      valueId: 'codeAvgPerCall', value: '0',
      subId: 'codeCallsSub', sub: '0 calls',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Call Resolution',
      valueId: 'codeResolutionVal', value: '—',
      subId: 'codeCallStats', sub: '0 / 0 calls resolved',
      pillId: 'codeResolutionPill',
      body: `<div class="chart-wrap chart-wrap--sm" style="height:84px;margin-top:.25rem">` +
        `<svg id="codeResolutionGauge" viewBox="0 0 600 140" preserveAspectRatio="xMidYMid meet" ` +
        `role="img" aria-label="Call resolution rate"></svg></div>`,
    })}</div>
    <div class="col-3">${kpi({
      label: 'Index Footprint',
      valueId: 'codeSymbolCount', value: '0',
      subId: 'codeFootprintSub', sub: 'symbols indexed',
    })}</div>
  </div>`;

  // ── Band C — Savings analytics (cumulative trend + by-tool Pareto) ─────────
  const analytics = `
  <div class="grid">
    <div class="col-8 card">
      <div class="section-head">
        <div class="section-title" style="margin:0">Cumulative Savings</div>
        <span class="card-sub" id="codeRunRate" style="margin:0">—</span>
      </div>
      <div class="chart-wrap"><svg id="codeSavingsTrend" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"></svg></div>
      <div class="card-sub" id="codeSavingsSummary" style="margin-top:.6rem">No code-nav tool calls recorded yet.</div>
    </div>
    <div class="col-4 card">
      <div class="section-title">Savings by Tool</div>
      <div id="codeByToolBars"></div>
    </div>
  </div>`;

  // ── Band D — Drill-down tables ─────────────────────────────────────────────
  const tables = `
  <div class="grid">
    <div class="col-6 card">
      <div class="section-title">By Tool</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Tool</th><th class="num">Calls</th><th class="num">Tokens Saved</th><th class="num">Avg / Call</th></tr>
          </thead>
          <tbody id="codeSavingsTable"></tbody>
        </table>
      </div>
    </div>
    <div class="col-6 card">
      <div class="section-title">By Repo</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Repo</th><th class="num">Calls</th><th class="num">Tokens Saved</th><th class="num">Avg / Call</th></tr>
          </thead>
          <tbody id="codeSavingsRepoTable"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="col-12 card">
      <div class="section-title">Indexed Repositories</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Slug</th>
              <th class="num">Symbols</th>
              <th class="num">Files</th>
              <th class="num">Symbols / File</th>
              <th>Last Indexed</th>
            </tr>
          </thead>
          <tbody id="codeRepoTable"></tbody>
        </table>
      </div>
    </div>
  </div>`;

  return soWhat + kpis + analytics + tables;
}
