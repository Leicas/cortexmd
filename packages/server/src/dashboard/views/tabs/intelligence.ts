/**
 * Intelligence tab — server-rendered HTML fragment for #tab-intelligence.
 *
 * Redesigned per INTELLIGENCE-REDESIGN.md: 7 stacked bands collapsed to 3
 * always-open bands + 1 collapsed disclosure, so the health hero + primary
 * action land above the fold and scroll roughly halves. Render order:
 *   Band 1 — VITALS: KPI row + so-what strip + gauge (col-3) / factors (col-9)
 *   Band 2 — DREAM ENGINE: dream insights (col-8) + Local LLM (col-4)
 *   Band 3 — DREAM FINDINGS: recommendations / themes / orphans, 3-up col-4
 *   Band 4 — STRUCTURE: entity intelligence (col-8) + knowledge graph (col-4)
 *   Band 5 — HISTORY & AGENTS: collapsed <details>, col-7 / col-5 inside
 *
 * Built from the shared component vocabulary (`kpi`, `sectionHead`,
 * `.grid`/`.col-*`, `.card--kpi`, `.sowhat`, `.chart-legend`, `.table-wrap`,
 * `drawGauge`/`drawMulti`/`drawChart`) — no ad-hoc styles. Every dynamic id the
 * client module writes is preserved (49 total); ids may live in a different
 * ancestor container but the client's `getElementById` writes are indifferent
 * to ancestry, so no binding moves. Action buttons keep their
 * `onclick="cortex.*"` bridge verbatim. `assets/tabs/intelligence.js` is NOT
 * touched.
 */
import { kpi, sectionHead } from '../components.js';

export function renderIntelligenceTab(): string {
  // ── Band 1 — VITALS: KPI scorecards ────────────────────────────────────────
  const vitalsKpis = `
  <div class="grid">
    <div class="col-3">${kpi({
      label: 'Vault Health', valueId: 'kpiHealthVal', value: '—',
      subId: 'kpiHealthSub', pillId: 'kpiHealthPill', deltaId: 'kpiHealthDelta',
      sparkId: 'kpiHealthSpark',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Entity Confirmation', valueId: 'kpiEntityVal', value: '—',
      subId: 'kpiEntitySub', pillId: 'kpiEntityPill',
    })}</div>
    <div class="col-3">${kpi({
      label: 'KG Density', valueId: 'kpiKgVal', value: '—',
      subId: 'kpiKgSub', pillId: 'kpiKgPill',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Dream Cadence', valueId: 'kpiDreamVal', value: '—',
      subId: 'kpiDreamSub', pillId: 'kpiDreamPill',
    })}</div>
  </div>`;

  // So-what strip sits between the two Vitals grid rows (full width, no col).
  const soWhat = `<div class="sowhat" id="intelSoWhat"></div>`;

  // ── Band 1 — VITALS: gauge (col-3) + health factors (col-9) ────────────────
  const vitalsGauge = `
  <div class="grid">
    <div class="col-3 card card--center">
      <div class="section-title" style="margin-bottom:.25rem">Vault Health Score</div>
      <div class="chart-wrap" style="height:150px" role="img" aria-labelledby="healthScoreValue healthGradeValue">
        <svg id="healthGauge" viewBox="0 0 600 140" preserveAspectRatio="xMidYMid meet" aria-hidden="true"></svg>
      </div>
      <div style="display:flex;align-items:baseline;justify-content:center;gap:.5rem;margin-top:-.25rem">
        <span id="healthScoreValue" class="card-sub" style="margin-top:0">—</span>
        <span id="healthGradeValue" class="card-sub" style="margin-top:0">—</span>
      </div>
    </div>
    <div class="col-9 card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Health Factors</div>
        <span class="card-sub" style="margin-top:0">contribution vs. potential — your biggest lever</span>
      </div>
      <div id="healthFactors"><span class="empty-msg">Awaiting health data…</span></div>
    </div>
  </div>`;

  // ── Band 2 — DREAM ENGINE: dream insights (col-8) + Local LLM (col-4) ──────
  const dreamEngine = `
  <div class="grid">
    <div class="col-8 card">
      ${sectionHead('Dream Insights', `
        <span id="dreamStatus" class="card-sub" style="margin-top:0">No dream run yet</span>
        <button class="btn btn-primary" id="btnDreamRun" onclick="cortex.runDreamCycle(false)">Run Dream</button>
        <button class="btn" id="btnDreamLlm" onclick="cortex.runDreamCycle(true)">LLM Dream</button>`)}
      <div id="dreamNarrative" class="card card--quiet" style="white-space:pre-wrap;line-height:1.6;min-height:60px;margin-top:.5rem"><span class="empty-msg">Run a dream cycle to analyze your vault and discover themes, orphans, and connection opportunities.</span></div>
      <div id="dreamActivity" class="grid" style="grid-template-columns:repeat(3,1fr);margin-top:.75rem;margin-bottom:0"></div>
    </div>
    <div class="col-4 card">
      <div class="section-head">
        <div class="section-title" style="margin-bottom:0">Local LLM</div>
        <span id="llmPill"></span>
      </div>
      <div class="card-sub" style="margin-top:.25rem">Model <span class="mono" id="llmModel">—</span></div>
      <div class="card-sub mono" id="llmUrl" style="word-break:break-all;color:var(--text-faint)"></div>
      <div id="llmError" class="state-error" role="alert" style="display:none;margin-top:.5rem"></div>
      <div style="margin-top:.75rem">
        <div class="card-label">Recent LLM Suggestions</div>
        <div id="llmSuggestions" style="margin-top:.4rem;max-height:160px;overflow-y:auto">
          <span class="empty-msg">No LLM suggestions yet. Run a dream cycle with LLM consolidation enabled.</span>
        </div>
      </div>
    </div>
  </div>`;

  // ── Band 3 — DREAM FINDINGS: recommendations / themes / orphans (3-up) ─────
  const findings = `
  <div class="grid">
    <div class="col-4 card">
      ${sectionHead('AI Recommendations', `<span id="recsCount" class="card-sub" style="margin-top:0"></span>`)}
      <div id="aiRecommendations" style="max-height:340px;overflow-y:auto">
        <span class="empty-msg">Run a dream cycle to generate connection suggestions and consolidation opportunities.</span>
      </div>
    </div>
    <div class="col-4 card">
      <div class="section-title">Theme Clusters</div>
      <div id="themeClusters" style="max-height:340px;overflow-y:auto">
        <span class="empty-msg">Run a dream cycle to detect recurring themes across your memories.</span>
      </div>
    </div>
    <div class="col-4 card">
      ${sectionHead('Orphan Memories', `<div id="orphanSummary" class="kpi-foot" style="margin-top:0"></div>`)}
      <div class="table-wrap" style="max-height:340px;overflow:auto">
        <table>
          <thead><tr>
            <th>Title</th>
            <th>Temp</th>
            <th class="num">Heat</th>
            <th class="num">Last Access</th>
            <th>Suggested Action</th>
          </tr></thead>
          <tbody id="orphanTableBody">
            <tr><td colspan="5" class="empty-msg" style="text-align:center">No orphans detected yet.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  // ── Band 4 — STRUCTURE: entity intelligence (col-8) + KG (col-4) ───────────
  const structure = `
  <div class="grid">
    <div class="col-8 card">
      ${sectionHead('Entity Intelligence', `<button class="btn btn-primary" id="btnEntityRebuild" onclick="cortex.rebuildEntities()">Rebuild entities</button>`)}
      <div class="grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:.75rem">
        <div>
          <div class="card-label">Total Entities</div>
          <div class="card-value card-value--xl" id="eiTotal">0</div>
        </div>
        <div>
          <div class="card-label">Confirmed</div>
          <div class="card-value card-value--xl" id="eiConfirmed" style="color:var(--ok)">0</div>
        </div>
        <div>
          <div class="card-label">Detected</div>
          <div class="card-value card-value--xl" id="eiDetected" style="color:var(--warn)">0</div>
        </div>
      </div>
      <div class="card-label">Detection Quality</div>
      <div class="stacked-bar" id="entityTierBar" style="margin-bottom:.5rem" role="img" aria-label="Entity detection tier distribution"></div>
      <div class="chart-legend" style="margin-bottom:.75rem">
        <span><i style="background:var(--ok)"></i>Confirmed</span>
        <span><i style="background:var(--warn)"></i>Detected</span>
        <span><i style="background:var(--info)"></i>Suggested</span>
      </div>
      <div class="card-label">Type Breakdown</div>
      <div id="entityTypeBars" style="margin-top:.4rem"></div>
      <div style="margin-top:.75rem">
        <div class="card-label">Entity Registry</div>
        <div class="table-wrap" style="max-height:220px;overflow-y:auto;margin-top:.4rem">
          <table>
            <thead><tr><th>Entity</th><th>Type</th><th class="num">Confidence</th><th>Status</th></tr></thead>
            <tbody id="entityRegistryBody">
              <tr><td colspan="4" class="empty-msg" style="text-align:center">No entities detected yet.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="col-4 card">
      ${sectionHead('Knowledge Graph', `<button class="btn btn-primary" id="btnKgBootstrap" onclick="cortex.postAction('/dashboard/api/kg/bootstrap',{})">Bootstrap KG</button>`)}
      <div class="grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:.75rem">
        <div>
          <div class="card-label">Entities</div>
          <div class="card-value" id="kgEntities">0</div>
        </div>
        <div>
          <div class="card-label">Triples</div>
          <div class="card-value" id="kgTriples">0</div>
        </div>
      </div>
      <div class="card-label">Top Predicates</div>
      <div id="kgPredicates" style="margin-top:.4rem">
        <span class="empty-msg">Knowledge graph empty — click Bootstrap KG to populate from vault notes.</span>
      </div>
    </div>
  </div>`;

  // ── Band 4.5 — RECALL ENGINE: multi-signal recall fusion (v1.10.0) ─────────
  const recallEngine = `
  <div class="grid">
    <div class="col-12 card">
      ${sectionHead('Recall Engine', `<span id="recallEnginePill"></span>`)}
      <div class="card-sub" style="margin-top:0;margin-bottom:.75rem">Multi-signal recall fusion — graph-centrality boost, Hebbian co-recall associations (spreading activation), and per-result explainability.</div>
      <div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:0">
        <div>
          <div class="card-label">Co-recall Links</div>
          <div class="card-value card-value--xl" id="reEdges">0</div>
          <div class="card-sub" style="margin-top:0">learned associations</div>
        </div>
        <div>
          <div class="card-label">Associated Memories</div>
          <div class="card-value card-value--xl" id="reNodes">0</div>
          <div class="card-sub" style="margin-top:0">notes in the graph</div>
        </div>
        <div>
          <div class="card-label">Centrality Weight</div>
          <div class="card-value card-value--xl" id="reCentralityW">—</div>
          <div class="card-sub" style="margin-top:0">graph-hub boost</div>
        </div>
        <div>
          <div class="card-label">Co-recall Weight</div>
          <div class="card-value card-value--xl" id="reCoRecallW">—</div>
          <div class="card-sub" style="margin-top:0">spreading activation</div>
        </div>
      </div>
      <div class="card-sub" style="margin-top:1rem;margin-bottom:.5rem"><strong>Contradiction resilience</strong> — reproducible Rescue@10 over the Bayesian-validity pipeline (a superseded fact is down-ranked or quarantined; the current fact survives). <a href="https://github.com/Leicas/cortexmd/blob/main/docs/BENCHMARKS.md" target="_blank" rel="noopener">methodology</a></div>
      <div class="grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:0">
        <div>
          <div class="card-label">Rescue@10</div>
          <div class="card-value card-value--xl" id="reRescue">—</div>
          <div class="card-sub" style="margin-top:0">current fact stays top-10</div>
        </div>
        <div>
          <div class="card-label">Superseded Demoted</div>
          <div class="card-value card-value--xl" id="reDemoted">—</div>
          <div class="card-sub" style="margin-top:0">stale fact down-ranked / dropped</div>
        </div>
        <div>
          <div class="card-label">Scenarios</div>
          <div class="card-value card-value--xl" id="reRescueCases">—</div>
          <div class="card-sub" style="margin-top:0">contradiction cases scored</div>
        </div>
      </div>
    </div>
  </div>`;

  // ── Band 5 — HISTORY & AGENTS: collapsed disclosure, col-7 / col-5 ─────────
  const historyAgents = `
  <details class="section">
    <summary>History &amp; Agents</summary>
    <div class="grid">
      <div class="col-7 card">
        <div class="section-title">Dream History</div>
        <div class="chart-wrap">
          <svg id="chartDreamHealth" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"></svg>
        </div>
        <div class="chart-legend">
          <span><i style="background:var(--ok)"></i>Health Score</span>
          <span><i style="background:var(--warn)"></i>Themes</span>
          <span><i style="background:var(--err)"></i>Orphans</span>
          <span><i style="background:var(--info)"></i>Decayed</span>
        </div>
        <div id="dreamHistoryTable" style="margin-top:.5rem;max-height:170px;overflow-y:auto">
          <span class="empty-msg">No dream cycles recorded yet.</span>
        </div>
      </div>
      <div class="col-5 card">
        <div class="section-title">Agent Awareness</div>
        <div class="card-sub" style="margin-top:0;margin-bottom:.5rem">What the AI has been thinking about</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Agent</th><th>Last Active</th><th class="num">Entries</th></tr></thead>
            <tbody id="agentDiariesBody">
              <tr><td colspan="3" class="empty-msg" style="text-align:center">No agent diaries found.</td></tr>
            </tbody>
          </table>
        </div>
        <div id="agentRecentActivity" style="margin-top:.75rem;max-height:170px;overflow-y:auto"></div>
      </div>
    </div>
  </details>`;

  return vitalsKpis + soWhat + vitalsGauge + dreamEngine + findings + structure + recallEngine + historyAgents;
}
