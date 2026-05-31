/**
 * Code tab — server-rendered HTML fragment for #tab-code.
 *
 * Markup migrated from the legacy `dashboard.ts` (the block between
 * `<!-- ====== TAB 6.5: Code ====== -->` and the next tab comment), minus the
 * outer `<div id="tab-code" class="tab-panel">` wrapper which the layout now
 * supplies. The ad-hoc `.data-table` tables are re-pointed at the base `table`
 * + `.table-wrap` component (per ARCHITECTURE §5) to match the Overview
 * reference; gross inline styles are migrated to token-driven classes
 * (`.card-sub`, `.section-title`) where a class exists. Fragment is static (no
 * user data); the client module `assets/tabs/code.js` fills the dynamic ids
 * over SSE from `data.codeNav` + `data.codeNavSavings`.
 */
export function renderCodeTab(): string {
  return `
  <div class="row row-4">
    <div class="card">
      <div class="card-label">Repos</div>
      <div class="card-value" id="codeRepoCount">0</div>
    </div>
    <div class="card">
      <div class="card-label">Symbols</div>
      <div class="card-value" id="codeSymbolCount">0</div>
    </div>
    <div class="card">
      <div class="card-label">Files</div>
      <div class="card-value" id="codeFileCount">0</div>
    </div>
    <div class="card">
      <div class="card-label">DB Size</div>
      <div class="card-value" id="codeDbSize">0</div>
      <div class="card-sub" id="codeCallStats">0 / 0 calls resolved</div>
    </div>
  </div>

  <div class="row row-1">
    <div class="card">
      <div class="section-title">Per-Repo Stats</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Slug</th><th>Symbols</th><th>Files</th><th>Last Indexed</th></tr>
          </thead>
          <tbody id="codeRepoTable"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="row row-1">
    <div class="card">
      <div class="section-title">Token Savings (vs Read/Grep baseline)</div>
      <div class="card-sub" id="codeSavingsSummary" style="margin-bottom:.6rem">No code-nav tool calls recorded yet.</div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Tool</th><th>Calls</th><th>Tokens Saved</th><th>Avg / Call</th></tr>
          </thead>
          <tbody id="codeSavingsTable"></tbody>
        </table>
      </div>
      <div class="card-label" style="margin-top:1rem">By Repo</div>
      <div class="table-wrap" style="margin-top:.4rem">
        <table>
          <thead>
            <tr><th>Repo</th><th>Calls</th><th>Tokens Saved</th><th>Avg / Call</th></tr>
          </thead>
          <tbody id="codeSavingsRepoTable"></tbody>
        </table>
      </div>
      <div class="card-sub" id="codeSavingsChart" style="margin-top:.7rem"></div>
    </div>
  </div>`;
}
