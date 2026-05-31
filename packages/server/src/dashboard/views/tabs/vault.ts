/**
 * Vault & Memory tab — server-rendered HTML fragment for #tab-vault.
 *
 * Markup lifted from the legacy `dashboard.ts` (the block between
 * `<!-- ====== TAB 4: Vault & Memory ====== -->` and the next tab comment),
 * minus the outer `<div id="tab-vault" class="tab-panel">` wrapper which the
 * layout now supplies. Repeated inline flex/form/badge blocks are re-templated
 * onto the canonical component classes (`.section-head`, `.field`,
 * `.field-label`, `.input`, `.textarea`) from app.css — same DOM ids, same
 * `var(--*)` tokens the client module references. The client module
 * `assets/tabs/vault.js` fills the dynamic ids over SSE + source-vault fetches.
 */
export function renderVaultTab(): string {
  return `
  <div class="row row-1">
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Read-only Vaults</div>
        <button class="btn" onclick="cortex.loadSourceVaults()">Refresh</button>
      </div>
      <div class="card-sub" style="margin-bottom:.75rem">
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
              <th>Indexed</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="sourceVaultsBody"><tr><td colspan="7" class="empty-msg">Loading...</td></tr></tbody>
        </table>
      </div>

      <div style="margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem">
        <div class="section-title" style="font-size:.85rem">Add a read-only vault</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:.5rem">
          <div class="field">
            <label class="field-label" for="svPath">Folder path *</label>
            <input id="svPath" class="input" type="text" placeholder="/abs/path/to/vault" autocomplete="off">
          </div>
          <div class="field">
            <label class="field-label" for="svName">Name (optional)</label>
            <input id="svName" class="input" type="text" placeholder="defaults to folder name" autocomplete="off">
          </div>
        </div>
        <div class="field" style="margin-top:.5rem">
          <label class="field-label" for="svGlobs">Include globs (optional, comma or newline separated)</label>
          <textarea id="svGlobs" class="textarea" rows="2" placeholder="**/*.md, notes/**"></textarea>
        </div>
        <div style="display:flex;align-items:center;gap:.75rem;margin-top:.6rem">
          <button class="btn btn-primary" id="svAddBtn" onclick="cortex.addSourceVault()">Add vault</button>
          <span id="svFeedback" style="font-size:.78rem"></span>
        </div>
      </div>
    </div>
  </div>

  <div class="row row-3">
    <div class="card">
      <div class="section-title">Vault Index</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem">
        <span>Indexed notes: <strong class="mono" id="vaultNotes">0</strong></span>
        <button class="btn btn-primary" onclick="cortex.postAction('/dashboard/api/index/rebuild',{})">Rebuild Now</button>
      </div>
      <div class="card-sub" id="vaultRebuild">&mdash;</div>
      <div id="indexHealthInfo" style="margin-top:.5rem;font-size:.75rem"></div>
    </div>
    <div class="card">
      <div class="section-title">Memory Temperature</div>
      <div style="display:flex;gap:1rem;margin-bottom:.5rem">
        <span class="badge badge-hot" id="memHot">Hot: 0</span>
        <span class="badge badge-warm" id="memWarm">Warm: 0</span>
        <span class="badge badge-cold" id="memCold">Cold: 0</span>
      </div>
      <div class="stacked-bar" id="memBar"></div>
    </div>
    <div class="card">
      <div class="section-title">Semantic Search</div>
      <div style="display:flex;gap:1rem;align-items:center;margin-bottom:.5rem">
        <span class="badge badge--info" id="embeddingBadge">Loading...</span>
      </div>
      <div class="card-sub">Model: <span class="mono" id="embModel">&mdash;</span></div>
      <div class="card-sub">Vectors: <span class="mono" id="embVectors">0</span></div>
      <div class="card-sub">Avg embed: <span class="mono" id="embAvgTime">&mdash;</span></div>
    </div>
  </div>

  <div class="row row-1">
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Vault Migration</div>
        <div class="section-head-actions">
          <button class="btn" onclick="cortex.runMigrationAction(true)">Dry Run</button>
          <button class="btn btn-primary" id="btnMigrateRun" onclick="cortex.runMigrationAction(false)">Migrate Now</button>
        </div>
      </div>
      <div class="card-sub" style="margin-bottom:.5rem">Move memories to year/month subfolders, split journal into daily files, split diaries into per-day files, merge insight/insights.</div>
      <div id="migrationResult" style="font-size:.78rem;max-height:200px;overflow-y:auto"></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Memory Stack (L0 + L1)</div>
      <div id="memoryStackL0" style="margin-bottom:.75rem">
        <div class="card-label">L0 &mdash; Identity</div>
        <div id="msIdentity" style="font-size:.8rem;color:var(--text);padding:.4rem .6rem;background:rgba(88,166,255,.05);border-radius:6px;border:1px solid var(--border);margin-top:.25rem;white-space:pre-wrap"><span class="empty-msg">Loading identity...</span></div>
      </div>
      <div id="memoryStackL1">
        <div class="card-label">L1 &mdash; Essential Narrative</div>
        <div id="msNarrative" style="font-size:.75rem;color:var(--text);padding:.4rem .6rem;background:rgba(63,185,80,.05);border-radius:6px;border:1px solid var(--border);margin-top:.25rem;max-height:280px;overflow-y:auto;white-space:pre-wrap"><span class="empty-msg">Loading narrative...</span></div>
      </div>
      <div style="margin-top:.5rem;font-size:.65rem;color:var(--text-dim)">
        Total tokens: <span class="mono" id="msTokenCount">0</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Search Quality Benchmarks</div>
      <!-- TODO: wire to benchmark results after Phase 10 integration -->
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div>
          <div class="card-label">Recall@5</div>
          <div class="card-value mono" id="sqbRecall5" style="font-size:1.3rem;color:var(--text-dim)">&mdash;</div>
        </div>
        <div>
          <div class="card-label">NDCG@10</div>
          <div class="card-value mono" id="sqbNdcg10" style="font-size:1.3rem;color:var(--text-dim)">&mdash;</div>
        </div>
        <div>
          <div class="card-label">Avg Latency</div>
          <div class="card-value mono" id="sqbAvgLat" style="font-size:1.3rem;color:var(--text-dim)">&mdash;</div>
        </div>
        <div>
          <div class="card-label">Last Run</div>
          <div class="card-value mono" id="sqbLastRun" style="font-size:.9rem;color:var(--text-dim)">&mdash;</div>
        </div>
      </div>
      <div style="margin-top:.75rem;font-size:.72rem;color:var(--text-dim)">
        Run a benchmark from the Retrieval Quality section below, or via the API, to populate these metrics.
      </div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Temperature Over Time</div>
      <div class="chart-wrap" style="height:160px">
        <svg id="chartTempHistory" viewBox="0 0 600 160" preserveAspectRatio="none"></svg>
      </div>
      <div style="display:flex;gap:1rem;margin-top:.5rem;font-size:.7rem">
        <span style="color:var(--red)">&#9632; Hot</span>
        <span style="color:var(--yellow)">&#9632; Warm</span>
        <span style="color:var(--blue)">&#9632; Cold</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Heat Score Distribution</div>
      <div id="heatHistogram" style="display:flex;gap:8px;align-items:flex-end;height:120px;padding-top:8px"></div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:.4rem;font-size:.65rem;color:var(--text-dim)">
        <span style="flex:1;text-align:center">0–3</span>
        <span style="flex:1;text-align:center">4–7</span>
        <span style="flex:1;text-align:center">8–11</span>
        <span style="flex:1;text-align:center">12+</span>
      </div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Top 10 Hottest Notes</div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Title</th><th>Score</th><th>Temp</th><th>Category</th><th>Last Accessed</th>
          </tr></thead>
          <tbody id="topNotesBody"></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Memory Categories</div>
      <div id="categoryBars"></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Search Quality</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div><div class="card-label">Total Searches</div><div class="card-value mono" id="sqTotal" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Avg Results</div><div class="card-value mono" id="sqAvgResults" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Avg Latency</div><div class="card-value mono" id="sqAvgLatency" style="font-size:1.3rem">&mdash;</div></div>
        <div><div class="card-label">Zero-Result Rate</div><div class="card-value mono" id="sqZeroRate" style="font-size:1.3rem">0%</div></div>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Recent Searches</div>
      <div class="feed" id="recentSearchesFeed" style="max-height:200px"><div class="empty-msg">No searches recorded.</div></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Vault Health</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div><div class="card-label">Total Indexed Files</div><div class="card-value mono" id="vhTotal" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Archived Notes</div><div class="card-value mono" id="vhArchived" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Stale Notes (60d+)</div><div class="card-value mono" id="vhStale" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">File Types</div><div id="vhFileTypes" style="font-size:.75rem;color:var(--text-dim);font-family:var(--mono)">&mdash;</div></div>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Link Density</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div><div class="card-label">Total Wiki-Links</div><div class="card-value mono" id="ldTotal" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Avg Links / Note</div><div class="card-value mono" id="ldAvg" style="font-size:1.3rem">0</div></div>
        <div><div class="card-label">Orphan Notes</div><div class="card-value mono" id="ldOrphans" style="font-size:1.3rem;color:var(--yellow)">0</div></div>
        <div><div class="card-label">Most Linked</div><div id="ldMostLinked" style="font-size:.72rem;color:var(--text-dim);font-family:var(--mono);max-height:80px;overflow-y:auto">&mdash;</div></div>
      </div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Search Analytics</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.75rem">
        <div><div class="card-label">Lexical-Only Hits</div><div class="card-value mono" id="saLexOnly" style="font-size:1.2rem;color:var(--blue)">0</div></div>
        <div><div class="card-label">Semantic-Only Hits</div><div class="card-value mono" id="saSemOnly" style="font-size:1.2rem;color:var(--green)">0</div></div>
        <div><div class="card-label">Both (Hybrid)</div><div class="card-value mono" id="saBoth" style="font-size:1.2rem;color:var(--yellow)">0</div></div>
      </div>
      <div class="card-label">Average Score Contribution</div>
      <div class="stacked-bar" id="saContribBar" style="margin-top:.35rem"></div>
      <div style="display:flex;gap:1rem;margin-top:.35rem;font-size:.65rem">
        <span style="color:var(--blue)">&#9632; Lexical</span>
        <span style="color:var(--green)">&#9632; Semantic</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Memory Lifecycle</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;margin-bottom:.75rem">
        <div><div class="card-label">Total Archived</div><div class="card-value mono" id="mlArchived" style="font-size:1.2rem">0</div></div>
        <div><div class="card-label">Total Consolidated</div><div class="card-value mono" id="mlConsolidated" style="font-size:1.2rem">0</div></div>
      </div>
      <div class="card-label">Temperature Distribution (all notes)</div>
      <div class="stacked-bar" id="mlTempBar" style="margin-top:.35rem"></div>
      <div style="display:flex;gap:1rem;margin-top:.35rem;font-size:.65rem">
        <span style="color:var(--red)">&#9632; Hot</span>
        <span style="color:var(--yellow)">&#9632; Warm</span>
        <span style="color:var(--blue)">&#9632; Cold</span>
        <span style="color:var(--text-dim)">&#9632; Unset</span>
      </div>
      <div id="mlRecentOps" style="margin-top:.75rem;max-height:120px;overflow-y:auto;font-size:.72rem"><div class="empty-msg">No recent lifecycle events.</div></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Recent Memory Operations</div>
      <div class="feed" id="memoryOpsFeed" style="max-height:260px"><div class="empty-msg">No memory operations recorded.</div></div>
    </div>
    <div class="card">
      <div class="section-title">Recent Notes Accessed</div>
      <div class="feed" id="notesAccessFeed" style="max-height:260px"><div class="empty-msg">No notes accessed yet.</div></div>
    </div>
  </div>

  <div class="row row-2">
    <div class="card">
      <div class="section-title">Collections</div>
      <div id="collectionBars"><div class="empty-msg">No collection data.</div></div>
    </div>
    <div class="card">
      <div class="section-title">Score Breakdown (Recent Searches)</div>
      <div id="scoreBreakdowns" style="max-height:260px;overflow-y:auto"><div class="empty-msg">No searches with score data.</div></div>
    </div>
  </div>

  <div class="row row-1">
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Retrieval Quality Benchmark</div>
        <div class="section-head-actions">
          <button class="btn btn-primary" onclick="cortex.postAction('/dashboard/api/benchmark/run',{})">Run Benchmark</button>
          <button class="btn" id="btnSaveGroundTruth" onclick="cortex.postAction('/dashboard/api/benchmark/save-ground-truth',{})" style="display:none">Save as Ground Truth</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:.5rem;margin-bottom:.75rem" id="benchmarkGauges"></div>
      <div class="card-sub" id="benchmarkTimestamp">No benchmark run yet</div>
      <div class="table-wrap" style="margin-top:.75rem">
        <table>
          <thead><tr><th>Query</th><th>Results</th><th>P@5</th><th>P@10</th><th>NDCG@10</th><th>Latency</th><th>Top Retrieved</th></tr></thead>
          <tbody id="benchmarkTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>`;
}
