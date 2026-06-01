/**
 * Vault & Memory tab — server-rendered HTML fragment for #tab-vault.
 *
 * REVAMP.md §5 TAB 4. The densest tab, reorganised into the new design system:
 *   - a "so what?" insight strip + 4 promoted KPI tiles (retrieval quality,
 *     hybrid balance, temperature balance gauge, embedding/health ratios)
 *   - three IA zones via `sectionHead`:
 *       1. Index & Admin   — vaults table, add-vault form, rebuild, migration
 *       2. Memory & Search — temperature, semantic search, memory stack, search
 *                            quality, recent searches (live)
 *       3. Analytics       — the deep block, wrapped in a native <details.section>
 *                            (zero-JS, keyboard-accessible): temp-over-time, heat
 *                            histogram, top notes, categories, collections, score
 *                            breakdowns, vault health, link density, search
 *                            analytics, lifecycle, benchmark.
 *
 * EVERY dynamic id the client module (`assets/tabs/vault.js`) writes is
 * preserved (sourceVaultsBody, vaultNotes, vaultRebuild, indexHealthInfo,
 * memHot/Warm/Cold, memBar, embeddingBadge, embModel, embVectors, embAvgTime,
 * topNotesBody, categoryBars, sqTotal/AvgResults/AvgLatency/ZeroRate,
 * recentSearchesFeed, vhTotal/Archived/Stale/FileTypes, ldTotal/Avg/Orphans/
 * MostLinked, saLexOnly/SemOnly/Both, saContribBar, mlArchived/Consolidated,
 * mlTempBar, mlRecentOps, memoryOpsFeed, notesAccessFeed, collectionBars,
 * scoreBreakdowns, msIdentity, msNarrative, msTokenCount, sqbRecall5/Ndcg10/
 * AvgLat/LastRun, benchmarkGauges, benchmarkTimestamp, benchmarkTableBody,
 * btnSaveGroundTruth, chartTempHistory, heatHistogram). New ids added for the
 * promoted KPI tiles + benchmark dot-plot are filled in the same module.
 *
 * Built from the shared components (`kpi`, `sectionHead`, `statusPill`) so the
 * tile vocabulary matches Overview. No new endpoints / payload fields.
 */
import { kpi, sectionHead, statusPill } from '../components.js';

export function renderVaultTab(): string {
  // ── Insight strip + promoted KPIs ─────────────────────────────────────────
  const sowhat = `<div class="sowhat" id="vaultSoWhat"></div>`;

  const kpis = `
  <div class="grid">
    <div class="col-3">${kpi({
      label: 'Retrieval Quality', valueId: 'kpiZeroRate', value: '—',
      subId: 'kpiZeroSub', pillId: 'kpiZeroPill',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Hybrid Balance', valueId: 'kpiHybridVal', value: '—',
      subId: 'kpiHybridSub',
      body: `<div class="stacked-bar stacked-bar--sm" id="kpiHybridBar" role="img" aria-label="Lexical vs semantic score contribution"></div>`,
    })}</div>
    <div class="col-3 card card--kpi card--center" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.25rem">
      <div class="card-label" style="justify-content:center">Temperature Balance</div>
      <div class="chart-wrap chart-wrap--sm" style="height:96px;width:100%">
        <svg id="kpiTempGauge" viewBox="0 0 600 140" preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="kpiTempGaugeLbl"></svg>
      </div>
      <div class="card-sub" id="kpiTempSub" style="margin-top:0"></div>
      <span id="kpiTempGaugeLbl" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Memory temperature balance index</span>
    </div>
    <div class="col-3">${kpi({
      label: 'Embedding Coverage', valueId: 'kpiCoverageVal', value: '—',
      subId: 'kpiCoverageSub', pillId: 'kpiCoveragePill',
      body: `<div class="kpi-foot" id="kpiRatioFoot" style="margin-top:.45rem"></div>`,
      linkTab: undefined,
    })}</div>
  </div>`;

  // ── Zone 1 — Index & Admin ────────────────────────────────────────────────
  const zoneIndex = `
  <div class="grid">
    <div class="col-12 card">
      ${sectionHead('Read-only Vaults', `<button class="btn" onclick="cortex.loadSourceVaults()">Refresh</button>`)}
      <div class="card-sub" style="margin:0 0 .75rem">
        Additional source folders indexed read-only. Env-managed entries (SOURCE_VAULTS) are immutable; persisted entries can be removed here. Adding or removing a vault triggers a background reindex.
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Path</th>
              <th>Include Globs</th>
              <th>Source</th>
              <th class="num">Indexed</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="sourceVaultsBody"><tr><td colspan="7" class="empty-msg">Loading…</td></tr></tbody>
        </table>
      </div>

      <div style="margin-top:1rem;border-top:1px solid var(--line-faint);padding-top:1rem">
        <div class="card-label">Add a read-only vault</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:.5rem">
          <div class="field">
            <label class="field-label" for="svPath">Folder path *</label>
            <input id="svPath" class="input mono" type="text" placeholder="/abs/path/to/vault" autocomplete="off">
          </div>
          <div class="field">
            <label class="field-label" for="svName">Name (optional)</label>
            <input id="svName" class="input" type="text" placeholder="defaults to folder name" autocomplete="off">
          </div>
        </div>
        <div class="field" style="margin-top:.5rem">
          <label class="field-label" for="svGlobs">Include globs (optional, comma or newline separated)</label>
          <textarea id="svGlobs" class="textarea mono" rows="2" placeholder="**/*.md, notes/**"></textarea>
        </div>
        <div style="display:flex;align-items:center;gap:.75rem;margin-top:.6rem">
          <button class="btn btn-primary" id="svAddBtn" onclick="cortex.addSourceVault()">Add vault</button>
          <span id="svFeedback" class="card-sub" style="margin:0"></span>
        </div>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="col-6 card">
      ${sectionHead('Vault Index', `<button class="btn btn-primary" onclick="cortex.postAction('/dashboard/api/index/rebuild',{})">Rebuild Now</button>`)}
      <div style="display:flex;align-items:baseline;gap:.5rem">
        <span class="card-value card-value--xl" id="vaultNotes">0</span>
        <span class="card-label" style="margin:0">indexed notes</span>
      </div>
      <div class="card-sub" id="vaultRebuild">—</div>
      <div id="indexHealthInfo" style="margin-top:.6rem;font-size:var(--fs-sm)"></div>
    </div>
    <div class="col-6 card">
      ${sectionHead('Vault Migration', `
        <button class="btn" onclick="cortex.runMigrationAction(true)">Dry Run</button>
        <button class="btn btn-primary" id="btnMigrateRun" onclick="cortex.runMigrationAction(false)">Migrate Now</button>`)}
      <div class="card-sub" style="margin:0 0 .5rem">Move memories to year/month subfolders, split journal into daily files, split diaries into per-day files, merge insight/insights.</div>
      <div id="migrationResult" style="font-size:var(--fs-sm);max-height:200px;overflow-y:auto"></div>
    </div>
  </div>`;

  // ── Zone 2 — Memory & Search (live) ───────────────────────────────────────
  const zoneMemory = `
  <div class="grid">
    <div class="col-4 card">
      <div class="section-title">Memory Temperature</div>
      <div class="kpi-foot" style="margin-top:0;margin-bottom:.5rem">
        <span class="badge badge-hot" id="memHot">Hot: 0</span>
        <span class="badge badge-warm" id="memWarm">Warm: 0</span>
        <span class="badge badge-cold" id="memCold">Cold: 0</span>
      </div>
      <div class="stacked-bar" id="memBar" role="img" aria-label="Memory temperature distribution"></div>
    </div>
    <div class="col-4 card">
      <div class="section-title">Semantic Search</div>
      <div class="kpi-foot" style="margin-top:0;margin-bottom:.5rem">
        <span class="badge badge--info" id="embeddingBadge">Loading…</span>
      </div>
      <div class="card-sub">Model: <span class="mono" id="embModel">—</span></div>
      <div class="card-sub">Vectors: <span class="mono" id="embVectors">0</span></div>
      <div class="card-sub">Avg embed: <span class="mono" id="embAvgTime">—</span></div>
    </div>
    <div class="col-4 card">
      <div class="section-title">Search Quality</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.6rem">
        <div><div class="card-label">Total Searches</div><div class="card-value card-value--xl mono" id="sqTotal">0</div></div>
        <div><div class="card-label">Avg Results</div><div class="card-value card-value--xl mono" id="sqAvgResults">0</div></div>
        <div><div class="card-label">Avg Latency</div><div class="card-value card-value--xl mono" id="sqAvgLatency">—</div></div>
        <div><div class="card-label">Zero-Result</div><div class="card-value card-value--xl mono" id="sqZeroRate">0%</div></div>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="col-8 card">
      <div class="section-title">Memory Stack (L0 + L1)</div>
      <div id="memoryStackL0" style="margin-bottom:.75rem">
        <div class="card-label">L0 — Identity</div>
        <div id="msIdentity" class="card--quiet" style="font-size:var(--fs-md);color:var(--text);padding:.5rem .65rem;border-radius:var(--r-sm);border:1px solid var(--border);margin-top:.3rem;white-space:pre-wrap"><span class="empty-msg">Loading identity…</span></div>
      </div>
      <div id="memoryStackL1">
        <div class="card-label">L1 — Essential Narrative</div>
        <div id="msNarrative" class="card--quiet" style="font-size:var(--fs-sm);color:var(--text);padding:.5rem .65rem;border-radius:var(--r-sm);border:1px solid var(--border);margin-top:.3rem;max-height:280px;overflow-y:auto;white-space:pre-wrap"><span class="empty-msg">Loading narrative…</span></div>
      </div>
      <div class="card-sub" style="margin-top:.6rem">Total tokens: <span class="mono" id="msTokenCount">0</span></div>
    </div>
    <div class="col-4 card">
      <div class="section-title">Recent Searches</div>
      <div class="feed" id="recentSearchesFeed" style="max-height:300px"><div class="empty-msg">No searches recorded.</div></div>
    </div>
  </div>`;

  // ── Zone 3 — Analytics (deep, collapsible) ────────────────────────────────
  const zoneAnalytics = `
  <details class="section" id="vaultAnalytics">
    <summary><span class="section-title" style="display:inline;margin:0">Analytics &amp; Deep Metrics</span></summary>

    <div class="grid">
      <div class="col-6 card">
        <div class="section-title">Temperature Over Time</div>
        <div class="chart-wrap" style="height:160px">
          <svg id="chartTempHistory" viewBox="0 0 600 160" preserveAspectRatio="none" aria-hidden="true"></svg>
        </div>
        <div class="chart-legend">
          <span><i style="background:var(--err)"></i>Hot</span>
          <span><i style="background:var(--warn)"></i>Warm</span>
          <span><i style="background:var(--info)"></i>Cold</span>
        </div>
      </div>
      <div class="col-6 card">
        <div class="section-title">Heat Score Distribution</div>
        <div class="chart-wrap chart-wrap--sm" style="height:120px">
          <svg id="heatHistogram" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"></svg>
        </div>
        <div style="display:flex;gap:8px;justify-content:space-between;margin-top:.4rem;font-size:var(--fs-xs);color:var(--text-dim);font-family:var(--mono)">
          <span style="flex:1;text-align:center">0–3</span>
          <span style="flex:1;text-align:center">4–7</span>
          <span style="flex:1;text-align:center">8–11</span>
          <span style="flex:1;text-align:center">12+</span>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="col-6 card">
        <div class="section-title">Top 10 Hottest Notes</div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Title</th><th class="num">Score</th><th>Temp</th><th>Category</th><th>Last Accessed</th>
            </tr></thead>
            <tbody id="topNotesBody"></tbody>
          </table>
        </div>
      </div>
      <div class="col-6 card">
        <div class="section-title">Memory Categories</div>
        <div id="categoryBars"></div>
      </div>
    </div>

    <div class="grid">
      <div class="col-6 card">
        <div class="section-title">Vault Health</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
          <div><div class="card-label">Total Indexed Files</div><div class="card-value card-value--xl mono" id="vhTotal">0</div></div>
          <div><div class="card-label">Archived Notes</div><div class="card-value card-value--xl mono" id="vhArchived">0</div></div>
          <div><div class="card-label">Stale Notes (60d+)</div><div class="card-value card-value--xl mono" id="vhStale">0</div></div>
          <div><div class="card-label">File Types</div><div id="vhFileTypes" class="mono" style="font-size:var(--fs-sm);color:var(--text-dim)">—</div></div>
        </div>
      </div>
      <div class="col-6 card">
        <div class="section-title">Link Density</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
          <div><div class="card-label">Total Wiki-Links</div><div class="card-value card-value--xl mono" id="ldTotal">0</div></div>
          <div><div class="card-label">Avg Links / Note</div><div class="card-value card-value--xl mono" id="ldAvg">0</div></div>
          <div><div class="card-label">Orphan Notes</div><div class="card-value card-value--xl mono" id="ldOrphans">0</div></div>
          <div><div class="card-label">Most Linked</div><div id="ldMostLinked" class="mono" style="font-size:var(--fs-xs);color:var(--text-dim);max-height:80px;overflow-y:auto">—</div></div>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="col-6 card">
        <div class="section-title">Search Analytics</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.75rem">
          <div><div class="card-label">Lexical-Only</div><div class="card-value card-value--lg mono" id="saLexOnly" style="color:var(--info)">0</div></div>
          <div><div class="card-label">Semantic-Only</div><div class="card-value card-value--lg mono" id="saSemOnly" style="color:var(--ok)">0</div></div>
          <div><div class="card-label">Both (Hybrid)</div><div class="card-value card-value--lg mono" id="saBoth" style="color:var(--warn)">0</div></div>
        </div>
        <div class="card-label">Average Score Contribution</div>
        <div class="stacked-bar" id="saContribBar" style="margin-top:.35rem"></div>
        <div class="chart-legend">
          <span><i style="background:var(--info)"></i>Lexical</span>
          <span><i style="background:var(--ok)"></i>Semantic</span>
        </div>
      </div>
      <div class="col-6 card">
        <div class="section-title">Memory Lifecycle</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;margin-bottom:.75rem">
          <div><div class="card-label">Total Archived</div><div class="card-value card-value--lg mono" id="mlArchived">0</div></div>
          <div><div class="card-label">Total Consolidated</div><div class="card-value card-value--lg mono" id="mlConsolidated">0</div></div>
        </div>
        <div class="card-label">Temperature Distribution (all notes)</div>
        <div class="stacked-bar" id="mlTempBar" style="margin-top:.35rem"></div>
        <div class="chart-legend">
          <span><i style="background:var(--err)"></i>Hot</span>
          <span><i style="background:var(--warn)"></i>Warm</span>
          <span><i style="background:var(--info)"></i>Cold</span>
          <span><i style="background:var(--border-strong)"></i>Unset</span>
        </div>
        <div id="mlRecentOps" style="margin-top:.75rem;max-height:120px;overflow-y:auto;font-size:var(--fs-sm)"><div class="empty-msg">No recent lifecycle events.</div></div>
      </div>
    </div>

    <div class="grid">
      <div class="col-6 card">
        <div class="section-title">Recent Memory Operations</div>
        <div class="feed" id="memoryOpsFeed" style="max-height:260px"><div class="empty-msg">No memory operations recorded.</div></div>
      </div>
      <div class="col-6 card">
        <div class="section-title">Recent Notes Accessed</div>
        <div class="feed" id="notesAccessFeed" style="max-height:260px"><div class="empty-msg">No notes accessed yet.</div></div>
      </div>
    </div>

    <div class="grid">
      <div class="col-6 card">
        <div class="section-title">Collections</div>
        <div id="collectionBars"><div class="empty-msg">No collection data.</div></div>
      </div>
      <div class="col-6 card">
        <div class="section-title">Score Breakdown (Recent Searches)</div>
        <div id="scoreBreakdowns" style="max-height:260px;overflow-y:auto"><div class="empty-msg">No searches with score data.</div></div>
      </div>
    </div>

    <div class="grid">
      <div class="col-12 card">
        ${sectionHead('Retrieval Quality Benchmark', `
          <button class="btn btn-primary" onclick="cortex.postAction('/dashboard/api/benchmark/run',{})">Run Benchmark</button>
          <button class="btn" id="btnSaveGroundTruth" onclick="cortex.postAction('/dashboard/api/benchmark/save-ground-truth',{})" style="display:none">Save as Ground Truth</button>`)}
        <div style="display:grid;grid-template-columns:repeat(4,1fr) 1.4fr;gap:.75rem;align-items:start;margin-bottom:.75rem">
          <div id="benchmarkGauges" style="display:contents"></div>
          <div>
            <div class="card-label">NDCG@10 / Query</div>
            <div class="chart-wrap chart-wrap--sm" style="height:64px">
              <svg id="benchmarkDotPlot" viewBox="0 0 600 140" preserveAspectRatio="none" role="img" aria-label="NDCG@10 distribution across benchmark queries"></svg>
            </div>
          </div>
        </div>
        <div class="card-sub" id="benchmarkTimestamp">No benchmark run yet</div>
        <div class="table-wrap" style="margin-top:.75rem">
          <table>
            <thead><tr><th>Query</th><th class="num">Results</th><th class="num">P@5</th><th class="num">P@10</th><th class="num">NDCG@10</th><th class="num">Latency</th><th>Top Retrieved</th></tr></thead>
            <tbody id="benchmarkTableBody"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="col-12 card card--quiet">
        ${sectionHead('Benchmark Summary', statusPill('snapshot', 'muted', { dot: false }))}
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:.75rem">
          <div><div class="card-label">Recall@5</div><div class="card-value card-value--xl mono" id="sqbRecall5">—</div></div>
          <div><div class="card-label">NDCG@10</div><div class="card-value card-value--xl mono" id="sqbNdcg10">—</div></div>
          <div><div class="card-label">Avg Latency</div><div class="card-value card-value--xl mono" id="sqbAvgLat">—</div></div>
          <div><div class="card-label">Last Run</div><div class="card-value mono" id="sqbLastRun" style="font-size:var(--fs-md)">—</div></div>
        </div>
      </div>
    </div>
  </details>`;

  return sowhat + kpis + zoneIndex + zoneMemory + zoneAnalytics;
}
