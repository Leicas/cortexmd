/**
 * Intelligence tab — server-rendered HTML fragment for #tab-intelligence.
 *
 * Migrated verbatim from the legacy `dashboard.ts` (the block between
 * `<!-- ====== TAB 5: Intelligence ====== -->` and the next tab comment),
 * minus the outer `<div id="tab-intelligence" class="tab-panel">` wrapper which
 * the layout now supplies. Fragment is static (no user data); the client module
 * `assets/tabs/intelligence.js` fills the dynamic ids over SSE.
 *
 * Follows the overview reference: raw markup, design-token component classes
 * (`.section-head`, `.card--center`, `.btn--ghost`/`.btn--sm`), and the existing
 * intelligence component classes already present in `assets/app.css`
 * (`.theme-card`, `.rec-card`, `.action-badge`, `.health-factor`,
 * `.llm-suggestion`, `.dh-row`, `.dream-running`, `.stacked-bar`, `.cat-row`).
 * Action buttons keep their `onclick="cortex.*"` bridge into `window.cortex`.
 */
export function renderIntelligenceTab(): string {
  return `
  <!-- Row 1: Health Score + Dream Narrative + LLM Status -->
  <div class="row row-3">
    <div class="card card--center">
      <div class="card-label">Vault Health Score</div>
      <div id="healthGauge" style="position:relative;width:120px;height:120px;margin:.5rem auto">
        <svg viewBox="0 0 120 120" style="width:100%;height:100%">
          <circle cx="60" cy="60" r="50" fill="none" stroke="var(--border)" stroke-width="8"/>
          <circle id="healthArc" cx="60" cy="60" r="50" fill="none" stroke="var(--green)" stroke-width="8"
            stroke-dasharray="314" stroke-dashoffset="314" stroke-linecap="round"
            transform="rotate(-90 60 60)" style="transition:stroke-dashoffset .8s ease,stroke .3s"/>
        </svg>
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">
          <div id="healthScoreValue" class="mono" style="font-size:1.8rem;font-weight:700;color:var(--green)">--</div>
          <div id="healthGradeValue" style="font-size:.7rem;color:var(--text-dim)">--</div>
        </div>
      </div>
      <div id="healthFactors" style="text-align:left;font-size:.7rem;margin-top:.5rem"></div>
    </div>
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Dream Insights</div>
        <div class="section-head-actions">
          <span id="dreamStatus" style="font-size:.7rem;color:var(--text-dim)">No dream run yet</span>
          <button class="btn btn-primary" id="btnDreamRun" onclick="cortex.runDreamCycle(false)">Run Dream</button>
          <button class="btn" id="btnDreamLlm" onclick="cortex.runDreamCycle(true)" style="border-color:var(--green);color:var(--green)">LLM Dream</button>
        </div>
      </div>
      <div id="dreamNarrative" style="font-size:.8rem;color:var(--text);padding:.6rem .8rem;background:rgba(88,166,255,.04);border-radius:6px;border:1px solid var(--border);min-height:60px;line-height:1.6;white-space:pre-wrap">
        <span class="empty-msg">Run a dream cycle to analyze your vault and discover themes, orphans, and connection opportunities.</span>
      </div>
      <div id="dreamActivity" style="display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-top:.5rem">
      </div>
    </div>
    <div class="card">
      <div class="section-title">Local LLM</div>
      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem">
        <span id="llmDot" style="width:10px;height:10px;border-radius:50%;background:var(--text-dim);flex-shrink:0"></span>
        <span id="llmStatusText" style="font-size:.8rem">Checking...</span>
      </div>
      <div class="card-sub">Model: <span class="mono" id="llmModel">&mdash;</span></div>
      <div class="card-sub" id="llmUrl" style="font-size:.65rem;color:var(--text-dim);word-break:break-all"></div>
      <div class="card-sub" id="llmError" style="color:var(--red);display:none;font-size:.72rem;margin-top:.25rem"></div>
      <div style="margin-top:.75rem">
        <div class="card-label">Recent LLM Suggestions</div>
        <div id="llmSuggestions" style="margin-top:.25rem;max-height:140px;overflow-y:auto;font-size:.75rem">
          <span class="empty-msg">No LLM suggestions yet. Run a dream cycle with LLM consolidation enabled.</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Row 2: Theme Clusters + Actionable Recommendations -->
  <div class="row row-2">
    <div class="card">
      <div class="section-title">Theme Clusters</div>
      <div id="themeClusters" style="max-height:320px;overflow-y:auto">
        <span class="empty-msg">Run a dream cycle to detect recurring themes across your memories.</span>
      </div>
    </div>
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">AI Recommendations</div>
        <span id="recsCount" style="font-size:.7rem;color:var(--text-dim)"></span>
      </div>
      <div id="aiRecommendations" style="max-height:320px;overflow-y:auto">
        <span class="empty-msg">Run a dream cycle to generate connection suggestions and consolidation opportunities.</span>
      </div>
    </div>
  </div>

  <!-- Row 3: Orphan Memories -->
  <div class="row row-1">
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Orphan Memories</div>
        <div style="display:flex;gap:.75rem;font-size:.7rem" id="orphanSummary"></div>
      </div>
      <div class="table-wrap" style="max-height:240px;overflow-y:auto">
        <table>
          <thead><tr>
            <th>Title</th><th>Temp</th><th>Heat</th><th>Last Access</th><th>Suggested Action</th>
          </tr></thead>
          <tbody id="orphanTableBody">
            <tr><td colspan="5" class="empty-msg" style="text-align:center">No orphans detected yet.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Row 4: Entity Intelligence + Knowledge Graph -->
  <div class="row row-2">
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Entity Intelligence</div>
        <button class="btn btn-primary" id="btnEntityRebuild" onclick="cortex.rebuildEntities()">Rebuild entities</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:.75rem">
        <div>
          <div class="card-label">Total Entities</div>
          <div class="card-value mono" id="eiTotal" style="font-size:1.3rem">0</div>
        </div>
        <div>
          <div class="card-label">Confirmed</div>
          <div class="card-value mono" id="eiConfirmed" style="font-size:1.3rem;color:var(--green)">0</div>
        </div>
        <div>
          <div class="card-label">Detected</div>
          <div class="card-value mono" id="eiDetected" style="font-size:1.3rem;color:var(--yellow)">0</div>
        </div>
      </div>
      <div class="card-label">Detection Quality</div>
      <div class="stacked-bar" id="entityTierBar" style="margin-top:.35rem;margin-bottom:.5rem"></div>
      <div style="display:flex;gap:1rem;margin-bottom:.75rem;font-size:.65rem">
        <span style="color:var(--green)">&#9632; Confirmed</span>
        <span style="color:var(--yellow)">&#9632; Detected</span>
        <span style="color:var(--text-dim)">&#9632; Suggested</span>
      </div>
      <div class="card-label">Type Breakdown</div>
      <div id="entityTypeBars" style="margin-top:.35rem"></div>
      <div style="margin-top:.75rem">
        <div class="card-label">Entity Registry</div>
        <div class="table-wrap" style="max-height:200px;overflow-y:auto">
          <table>
            <thead><tr><th>Entity</th><th>Type</th><th>Confidence</th><th>Status</th></tr></thead>
            <tbody id="entityRegistryBody">
              <tr><td colspan="4" class="empty-msg" style="text-align:center">No entities detected yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Knowledge Graph</div>
        <button class="btn btn-primary" id="btnKgBootstrap" onclick="cortex.postAction('/dashboard/api/kg/bootstrap',{})">Bootstrap KG</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem">
        <div>
          <div class="card-label">Entities</div>
          <div class="card-value mono" id="kgEntities" style="font-size:1.3rem;color:var(--text-dim)">0</div>
        </div>
        <div>
          <div class="card-label">Triples</div>
          <div class="card-value mono" id="kgTriples" style="font-size:1.3rem;color:var(--text-dim)">0</div>
        </div>
      </div>
      <div style="margin-top:.75rem">
        <div class="card-label">Top Predicates</div>
        <div id="kgPredicates" style="margin-top:.25rem;font-size:.78rem"><span class="empty-msg">Knowledge graph empty — click Bootstrap KG to populate from vault notes.</span></div>
      </div>
    </div>
  </div>

  <!-- Row 5: Dream History + Agent Awareness -->
  <div class="row row-2">
    <div class="card">
      <div class="section-title">Dream History</div>
      <div class="chart-wrap" style="height:120px">
        <svg id="chartDreamHealth" viewBox="0 0 600 120" preserveAspectRatio="none"></svg>
      </div>
      <div style="display:flex;gap:1rem;margin-top:.3rem;font-size:.65rem">
        <span style="color:var(--green)">&#9632; Health Score</span>
        <span style="color:var(--yellow)">&#9632; Themes</span>
        <span style="color:var(--red)">&#9632; Orphans</span>
      </div>
      <div id="dreamHistoryTable" style="margin-top:.5rem;max-height:160px;overflow-y:auto;font-size:.75rem">
        <span class="empty-msg">No dream cycles recorded yet.</span>
      </div>
    </div>
    <div class="card">
      <div class="section-title">Agent Awareness</div>
      <div class="card-sub" style="margin-bottom:.5rem;font-style:italic;color:var(--text-dim)">What the AI has been thinking about</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Agent</th><th>Last Active</th><th>Entries</th></tr></thead>
          <tbody id="agentDiariesBody">
            <tr><td colspan="3" class="empty-msg" style="text-align:center">No agent diaries found.</td></tr>
          </tbody>
        </table>
      </div>
      <div id="agentRecentActivity" style="margin-top:.75rem;max-height:160px;overflow-y:auto;font-size:.75rem">
      </div>
    </div>
  </div>`;
}
