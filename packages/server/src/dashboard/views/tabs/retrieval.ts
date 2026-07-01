/**
 * Retrieval tab — server-rendered HTML fragment for #tab-retrieval.
 *
 * The "how well does recall work?" surface for the multi-arm fused recall stack:
 * lexical + semantic + PPR graph arms, the bitemporal KG (facts have a lifespan),
 * and the live eval A/B. Distinct from Intelligence (vault *curation*). See the
 * retrieval-visualization design doc §2.
 *
 * Layout (summary-before-detail, 12-col grid matching every other tab):
 *   - a "so what?" strip + 4 promoted KPI tiles (Recall@k / Point-in-Time /
 *     Stale Leak / Arms Active)
 *   - Recall Arms (col-7): the 3-arm fused-contribution bar (dormant arms are
 *     HATCHED, never zeroed) + arm weights + per-query mini strips
 *   - a compact Arm Legend companion (col-5)
 *   - Recall Quality (col-12): THE HERO — the arm A/B compare matrix
 *     (baseline vs bitemporal vs ppr vs ppr+bitemp) rendered as bars + signed
 *     delta chips, plus a cross-run trend; honest empty-state before first eval
 *   - Bitemporal KG (col-6): active-vs-superseded split + a validity timeline of
 *     recent supersession events ("facts have a lifespan")
 *   - Graph Recall (col-6): substrate health KPIs + an honest seed→spread glyph
 *
 * The client module (assets/tabs/retrieval.js) fills every dynamic id below from
 * `ctx.data.retrieval` + `ctx.data.derived.retrieval`. Built from the shared
 * component vocabulary (kpi / sectionHead / statusPill / emptyState) so the tile
 * language matches Overview & Vault. Chart primitives are the hand-rolled
 * charts.js helpers; the arm bar / validity spans / seed-spread glyph are inline
 * SVG the client writes into the CSS scaffolds (`.arm-bar` / `.validity-lane` /
 * `.arm-compare`). No new endpoints, no external chart lib.
 */
import { kpi, sectionHead, statusPill, emptyState } from '../components.js';

export function renderRetrievalTab(): string {
  // ── Insight strip + promoted KPIs ─────────────────────────────────────────
  const sowhat = `<div class="sowhat" id="retSoWhat"></div>`;

  const kpis = `
  <div class="grid">
    <div class="col-3">${kpi({
      label: 'Recall@k', valueId: 'kpiRecall', value: '—',
      subId: 'kpiRecallSub', deltaId: 'kpiRecallDelta',
      sparkId: 'kpiRecallSpark',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Point-in-Time', valueId: 'kpiPit', value: '—',
      subId: 'kpiPitSub', pillId: 'kpiPitPill', deltaId: 'kpiPitDelta',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Stale Leak', valueId: 'kpiLeak', value: '—',
      subId: 'kpiLeakSub', pillId: 'kpiLeakPill', deltaId: 'kpiLeakDelta',
    })}</div>
    <div class="col-3">${kpi({
      label: 'Arms Active', valueId: 'kpiArms', value: '—',
      subId: 'kpiArmsSub',
      body: `<div class="kpi-foot" id="kpiArmsChips" style="margin-top:.45rem"></div>`,
    })}</div>
  </div>`;

  // ── Recall Arms (col-7) + Arm Legend companion (col-5) ────────────────────
  const zoneArms = `
  <div class="grid">
    <div class="col-7 card">
      ${sectionHead('Recall Arms', `<span id="armPprPill"></span>`)}
      <div class="card-sub" style="margin:0 0 .25rem">Fused-score contribution, last <span class="mono" id="armSample">0</span> queries</div>
      <div class="arm-bar" id="armBar" role="img" aria-label="Fused score contribution by recall arm"></div>
      <div class="chart-legend" style="margin-top:.55rem">
        <span><i style="background:var(--brand)"></i>Lexical <span class="mono" id="armLexPct">—</span></span>
        <span><i style="background:var(--brand-2)"></i>Semantic <span class="mono" id="armSemPct">—</span></span>
        <span><i style="background:var(--info)"></i>Graph <span class="mono" id="armGraphPct">—</span></span>
      </div>

      <div style="margin-top:.9rem;border-top:1px solid var(--line-faint);padding-top:.65rem">
        <div class="card-label">Arm weights</div>
        <div style="display:flex;gap:1.25rem;margin-top:.35rem;flex-wrap:wrap">
          <div><span class="card-sub" style="margin:0">centrality</span> <span class="mono" id="armWCentrality" style="color:var(--text)">—</span></div>
          <div><span class="card-sub" style="margin:0">co-recall</span> <span class="mono" id="armWCoRecall" style="color:var(--text)">—</span></div>
          <div><span class="card-sub" style="margin:0">graph</span> <span class="mono" id="armWGraph" style="color:var(--text)">—</span></div>
        </div>
      </div>

      <div style="margin-top:.9rem">
        <div class="card-label">Per-query mix <span class="card-label-aux mono">newest →</span></div>
        <div id="armStrips" style="display:flex;gap:2px;margin-top:.4rem;height:34px;align-items:flex-end">
          <div class="empty-msg" style="padding:0">No queries recorded yet.</div>
        </div>
      </div>
    </div>

    <div class="col-5 card card--quiet">
      <div class="section-title">How recall fuses</div>
      <div class="card-sub" style="margin:0 0 .6rem">
        Every query blends up to three arms. Lexical (BM25) is always on and anchors
        the mix; semantic adds embedding neighbours; the PPR graph arm spreads over
        the entity / wikilink graph. A hatched segment means that arm is off — its
        weight is not silently folded into the others.
      </div>
      <div id="armState"></div>
    </div>
  </div>`;

  // ── Recall Quality — THE HERO (col-12) ────────────────────────────────────
  const zoneQuality = `
  <div class="grid">
    <div class="col-12 card" id="qualityCard" style="border-top:2px solid transparent;border-image:var(--brand-grad) 1;box-shadow:var(--brand-glow),var(--shadow-2)">
      ${sectionHead('Recall Quality', `<span class="card-sub" id="qualityMeta" style="margin:0">—</span>`)}
      <div class="card-sub" style="margin:0 0 .75rem">
        How each arm scores against the eval gold set. Baseline is the reference;
        each treatment shows the signed change.
      </div>
      <div id="qualityBody">
        <div class="arm-compare" id="armCompare" style="--arm-cols:4"></div>
        <div id="qualityTrend" style="margin-top:1.1rem;border-top:1px solid var(--line-faint);padding-top:.85rem;display:none">
          <div class="card-label">Trend across stored runs</div>
          <div class="chart-wrap chart-wrap--sm" style="height:96px">
            <svg id="qualityTrendChart" viewBox="0 0 600 140" preserveAspectRatio="none" role="img" aria-label="Headline metrics across stored eval runs"></svg>
          </div>
          <div class="chart-legend">
            <span><i style="background:var(--brand)"></i>Recall@k</span>
            <span><i style="background:var(--brand-2)"></i>Point-in-Time</span>
            <span><i style="background:var(--warn)"></i>Stale Leak</span>
          </div>
        </div>
      </div>
      <div id="qualityEmpty" style="display:none">
        ${emptyState('No eval run yet', 'Run npm run eval to score the recall arms against the gold set and populate this panel.')}
      </div>
    </div>
  </div>`;

  // ── Bitemporal KG (col-6) + Graph Recall (col-6) ──────────────────────────
  const zoneKgGraph = `
  <div class="grid">
    <div class="col-6 card">
      ${sectionHead('Bitemporal KG', `<span id="bitemporalPill"></span>`)}
      <div class="card-sub" style="margin:0 0 .4rem">Facts have a lifespan: a newer value closes the old one's validity window instead of overwriting it.</div>
      <div class="kpi-foot" style="margin-top:0;margin-bottom:.35rem">
        <span class="badge badge--ok" id="bitActiveBadge">Active: 0</span>
        <span class="badge badge--muted" id="bitSupersededBadge">Superseded: 0</span>
      </div>
      <div class="stacked-bar" id="bitBar" role="img" aria-label="Active vs superseded facts"></div>

      <div style="margin-top:.9rem">
        <div class="card-label">Recent supersessions</div>
        <div id="bitLanes" style="margin-top:.45rem">
          <div class="empty-msg" style="padding:0">No supersessions recorded.</div>
        </div>
      </div>
    </div>

    <div class="col-6 card">
      ${sectionHead('Graph Recall', `<span id="graphPprPill"></span>`)}
      <div class="card-sub" style="margin:0 0 .5rem">The entity / wikilink substrate the PPR arm ranks over.</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.6rem">
        <div><div class="card-label">Nodes</div><div class="card-value card-value--xl mono" id="grNodes">0</div></div>
        <div><div class="card-label">Edges</div><div class="card-value card-value--xl mono" id="grEdges">0</div></div>
        <div><div class="card-label">Entity Bridges</div><div class="card-value card-value--xl mono" id="grBridges">0</div></div>
        <div><div class="card-label">Avg Degree</div><div class="card-value card-value--xl mono" id="grAvgDeg">0</div></div>
      </div>

      <div style="margin-top:.9rem;border-top:1px solid var(--line-faint);padding-top:.7rem">
        <div class="card-label">Seed → spread <span class="card-label-aux mono" id="grSeedQuery"></span></div>
        <div id="grSpread" style="margin-top:.5rem">
          <div class="empty-msg" style="padding:0">No PPR query recorded yet.</div>
        </div>
      </div>
    </div>
  </div>`;

  return sowhat + kpis + zoneArms + zoneQuality + zoneKgGraph;
}
