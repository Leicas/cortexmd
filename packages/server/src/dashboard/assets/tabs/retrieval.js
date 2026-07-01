// retrieval.js — Retrieval tab client module (ES module, no build).
//
// Renders the "how well does recall work?" surface from ctx.data.retrieval +
// ctx.data.derived.retrieval (both streamed over the single SSE payload; see
// core.js + payload.types.ts RetrievalPayload). Idempotent: refresh() fully
// re-derives from ctx.data on activate and on every SSE push — no local state.
//
// Panels (design doc §2):
//   KPI row      — Recall@k / Point-in-Time / Stale Leak / Arms Active
//   Recall Arms  — 3-arm fused-contribution bar (dormant = HATCHED, not zeroed)
//   Recall Quality (HERO) — arm A/B compare matrix + cross-run trend
//   Bitemporal KG — active/superseded split + validity timeline of supersessions
//   Graph Recall — substrate health + honest seed→spread glyph
//
// Honesty rules encoded here: a dormant arm is shown hatched with a "dormant"
// pill (never a zero-width lie); PPR-off shows the graph substrate only; a
// real-vault run's inapplicable metrics (PIT/leak) read "n/a" rather than a fake
// 0; and the whole quality panel falls back to an empty-state before first eval.

/** @typedef {import('../core.js').Ctx} Ctx */

var PCT = function (v) { return Math.round((v || 0) * 100) + '%'; };
var F2 = function (v) { return (v == null ? 0 : v).toFixed(2); };

export default {
  id: 'retrieval',

  // No wiring needed — everything is derived from ctx.data each tick.
  init() {},

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    var d = (ctx.data && ctx.data.retrieval) || null;
    if (!d) return;
    var dv = ((ctx.data && ctx.data.derived) || {}).retrieval || {};

    renderSoWhat(ctx, d);
    renderKpis(ctx, d, dv);
    renderArms(el, ctx, d);
    renderQuality(el, ctx, d);
    renderBitemporal(el, ctx, d);
    renderGraph(el, ctx, d);
  },
};

// ── shared bits ──────────────────────────────────────────────────────────────

function pillHtml(state, label, dot) {
  return '<span class="pill pill--' + state + '">' +
    (dot === false ? '' : '<span class="dot" aria-hidden="true"></span>') + label + '</span>';
}

function deltaHtml(tr, invert) {
  if (!tr) return '';
  var dir = tr.dir || 'flat';
  var glyph = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  var pct = Math.abs(tr.pct || 0);
  return '<span class="kpi-delta ' + dir + (invert ? ' invert' : '') + '">' +
    '<span aria-hidden="true">' + glyph + '</span>' + pct + '%</span>';
}

/** State for a 0–1 metric via THRESHOLDS-equivalent cutoffs (mirrors derive.ts). */
function stateHigher(v, good, warn) {
  if (v >= good) return 'ok';
  if (v >= warn) return 'warn';
  return 'bad';
}
function stateLower(v, good, warn) {
  if (v <= good) return 'ok';
  if (v <= warn) return 'warn';
  return 'bad';
}

/** The baseline arm row from a quality report (delta reference). */
function baselineArm(quality) {
  if (!quality || !quality.arms) return null;
  for (var i = 0; i < quality.arms.length; i++) {
    if (quality.arms[i].arm === 'baseline') return quality.arms[i];
  }
  return quality.arms[0] || null;
}

// ── so-what strip ──────────────────────────────────────────────────────────

function renderSoWhat(ctx, d) {
  var elId = ctx.$('retSoWhat');
  if (!elId) return;
  var q = d.quality;
  var base = baselineArm(q);
  var parts = [];
  if (base) {
    parts.push('Recall <b>' + F2(base.recallAtK) + '</b>');
    if (q.mode === 'temporal') {
      parts.push('PIT <b>' + F2(base.pointInTimeAccuracy) + '</b>');
      parts.push('leak <b>' + PCT(base.staleLeakRate) + '</b>');
    }
    parts.push('last eval <b>' + ctx.fmt.fmtAgo(q.ranAt) + '</b>');
  } else {
    parts.push('No eval run yet — <b>npm run eval</b> to score the arms');
  }
  var active = [];
  if (d.armsActive) {
    if (d.armsActive.lexical) active.push('lexical');
    if (d.armsActive.semantic) active.push('semantic');
    if (d.armsActive.graph) active.push('graph');
  }
  parts.push('arms <b>' + active.join(' + ') + '</b>');
  elId.innerHTML = parts.join('<span aria-hidden="true">·</span>');
}

// ── KPI row ──────────────────────────────────────────────────────────────────

function renderKpis(ctx, d, dv) {
  var $ = ctx.$, setLive = ctx.setLive, charts = ctx.charts;
  var q = d.quality;
  var base = baselineArm(q);
  var realVault = q && q.mode === 'real-vault';

  // 1. Recall@k — always meaningful; trend from derived.recallTrend.
  if (base) {
    setLive('kpiRecall', F2(base.recallAtK));
    var rState = stateHigher(base.recallAtK, 0.8, 0.6);
    setHtml($, 'kpiRecallSub', 'k=' + (q.k || '—') + ' · ' + (q.mode || '—'));
    setHtml($, 'kpiRecallDelta', deltaHtml(dv.recallTrend, false));
  } else {
    setLive('kpiRecall', '—');
    setHtml($, 'kpiRecallSub', 'no eval yet');
    setHtml($, 'kpiRecallDelta', '');
  }
  // Recall spark from the quality history (recall@k per run).
  var hist = d.qualityHistory || [];
  charts.drawChart('kpiRecallSpark',
    hist.map(function (h) { return { y: h.recallAtK }; }), 'var(--brand)');

  // 2. Point-in-Time accuracy — temporal-only; n/a for real-vault.
  if (base && !realVault) {
    setLive('kpiPit', F2(base.pointInTimeAccuracy));
    setHtml($, 'kpiPitPill', pillHtml(stateHigher(base.pointInTimeAccuracy, 0.8, 0.5),
      d.bitemporal && d.bitemporal.enabled ? 'as-of on' : 'as-of off'));
    setHtml($, 'kpiPitDelta', deltaHtml(dv.pitTrend, false));
    setHtml($, 'kpiPitSub', 'time-travel query accuracy');
  } else {
    setLive('kpiPit', base ? 'n/a' : '—');
    setHtml($, 'kpiPitPill', base ? pillHtml('muted', 'real-vault') : '');
    setHtml($, 'kpiPitDelta', '');
    setHtml($, 'kpiPitSub', base ? 'not scored in real-vault mode' : 'no eval yet');
  }

  // 3. Stale Leak — lower is better (invert delta + lower-better state).
  if (base && !realVault) {
    setLive('kpiLeak', PCT(base.staleLeakRate));
    setHtml($, 'kpiLeakPill', pillHtml(stateLower(base.staleLeakRate, 0.05, 0.15), 'lower = better', false));
    setHtml($, 'kpiLeakDelta', deltaHtml(dv.staleLeakTrend, true));
    setHtml($, 'kpiLeakSub', 'superseded facts leaking in');
  } else {
    setLive('kpiLeak', base ? 'n/a' : '—');
    setHtml($, 'kpiLeakPill', '');
    setHtml($, 'kpiLeakDelta', '');
    setHtml($, 'kpiLeakSub', base ? 'not scored in real-vault mode' : 'no eval yet');
  }

  // 4. Arms Active — n / 3, with dormant chips.
  var a = d.armsActive || { lexical: true, semantic: false, graph: false };
  var n = (a.lexical ? 1 : 0) + (a.semantic ? 1 : 0) + (a.graph ? 1 : 0);
  setLive('kpiArms', n + ' / 3');
  setHtml($, 'kpiArmsSub', a.graph ? 'graph arm active' : 'ppr dormant');
  setHtml($, 'kpiArmsChips',
    armChip('lexical', a.lexical) + armChip('semantic', a.semantic) + armChip('graph', a.graph));
}

function armChip(name, on) {
  return '<span class="pill pill--' + (on ? 'ok' : 'muted') + '">' +
    '<span class="dot" aria-hidden="true"></span>' + name + (on ? '' : ' off') + '</span>';
}

// ── Recall Arms ───────────────────────────────────────────────────────────────

function renderArms(el, ctx, d) {
  var $ = ctx.$;
  var mix = d.armMix || { lexical: 0, semantic: 0, graph: 0, sampleQueries: 0 };
  var active = d.armsActive || { lexical: true, semantic: false, graph: false };
  var graphOn = !!active.graph;

  setText($, 'armSample', mix.sampleQueries || 0);

  // PPR state pill in the header (form encodes dormant vs active).
  setHtml($, 'armPprPill', graphOn ? pillHtml('ok', 'ppr active') : pillHtml('muted', 'ppr dormant'));

  // The 3-arm contribution bar. When the graph arm is dormant we still show a
  // hatched sliver so the arm's existence is legible — never a zero-width lie.
  var bar = $('armBar');
  if (bar) {
    var lex = mix.lexical || 0, sem = mix.semantic || 0, gr = mix.graph || 0;
    var segs = [];
    if (graphOn) {
      // three arms, proportional across the full track
      segs.push(armSeg('arm-lex', lex, PCT(lex)));
      segs.push(armSeg('arm-sem', sem, PCT(sem)));
      segs.push(armSeg('arm-graph', gr, PCT(gr)));
    } else {
      // dormant: reserve a fixed ~14% hatched slot for the off arm, and scale the
      // active arms into the remaining 86% — the slot is honest (flagged "dormant"),
      // never a zero-width lie nor an overflow that clips the hatch.
      var act = lex + sem || 1;
      segs.push(armSeg('arm-lex', (lex / act) * 0.86, PCT(lex)));
      segs.push(armSeg('arm-sem', (sem / act) * 0.86, PCT(sem)));
      segs.push('<div class="arm-seg arm-dormant" style="flex:0 0 14%" ' +
        'title="PPR graph arm is off — its weight is not folded into the others">dormant</div>');
    }
    bar.innerHTML = segs.join('');
  }

  setText($, 'armLexPct', PCT(mix.lexical));
  setText($, 'armSemPct', PCT(mix.semantic));
  setText($, 'armGraphPct', graphOn ? PCT(mix.graph) : 'off');

  // Arm weights (honest nulls → em dash / "off").
  var w = d.armWeights || {};
  setText($, 'armWCentrality', w.centrality == null ? '—' : F2(w.centrality));
  setText($, 'armWCoRecall', w.coRecall == null ? 'off' : F2(w.coRecall));
  setText($, 'armWGraph', w.graph == null ? 'off' : F2(w.graph));

  // State summary in the companion card.
  var stateEl = $('armState');
  if (stateEl) {
    stateEl.innerHTML =
      armStateRow('Lexical (BM25)', active.lexical, 'always on') +
      armStateRow('Semantic (embeddings)', active.semantic, active.semantic ? 'vectors ready' : 'not ready') +
      armStateRow('Graph (PPR)', active.graph, active.graph ? 'spreading over the graph' : 'enable PPR_RECALL to activate');
  }

  // Per-query mini stacked strips (newest last, right-aligned by DOM order).
  renderArmStrips(el, ctx, d.recentArmBreakdown || [], graphOn);
}

function armSeg(cls, frac, label) {
  var pct = Math.max(0, Math.min(100, (frac || 0) * 100));
  // Below ~7% a label won't fit; drop it rather than overflow.
  var text = pct >= 7 ? label : '';
  return '<div class="arm-seg ' + cls + '" style="flex:0 0 ' + pct.toFixed(2) + '%" title="' + label + '">' + text + '</div>';
}

function armStateRow(label, on, note) {
  return '<div style="display:flex;align-items:center;gap:.5rem;padding:.35rem 0;border-bottom:1px solid var(--line-faint)">' +
    pillHtml(on ? 'ok' : 'muted', on ? 'on' : 'off') +
    '<span style="color:var(--text)">' + label + '</span>' +
    '<span class="card-sub" style="margin:0 0 0 auto">' + note + '</span>' +
    '</div>';
}

function renderArmStrips(el, ctx, rows, graphOn) {
  var wrap = ctx.$('armStrips');
  if (!wrap) return;
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-msg" style="padding:0">No queries recorded yet.</div>';
    return;
  }
  // newest-right: rows arrive newest-last already; cap to what fits (30).
  var recent = rows.slice(-30);
  var html = recent.map(function (r) {
    var lex = (r.lexical || 0) * 100, sem = (r.semantic || 0) * 100, gr = (r.graph || 0) * 100;
    var title = ctx.escAttr((r.query || '') + '  ·  lex ' + Math.round(lex) + '% sem ' + Math.round(sem) + '% graph ' + Math.round(gr) + '%');
    var stack =
      '<div style="flex:0 0 ' + lex.toFixed(1) + '%;background:var(--brand)"></div>' +
      '<div style="flex:0 0 ' + sem.toFixed(1) + '%;background:var(--brand-2)"></div>' +
      (graphOn ? '<div style="flex:0 0 ' + gr.toFixed(1) + '%;background:var(--info)"></div>' : '');
    return '<div title="' + title + '" style="flex:1 1 0;min-width:3px;max-width:14px;height:100%;' +
      'display:flex;flex-direction:column-reverse;border-radius:2px;overflow:hidden;background:var(--bg-elev)">' +
      stack + '</div>';
  }).join('');
  wrap.innerHTML = html;
}

// ── Recall Quality (HERO) ──────────────────────────────────────────────────────

var METRICS = [
  { key: 'recallAtK',           label: 'recall@k',      fmt: F2,  lowerBetter: false },
  { key: 'pointInTimeAccuracy', label: 'point-in-time', fmt: F2,  lowerBetter: false },
  { key: 'staleLeakRate',       label: 'stale leak',    fmt: PCT, lowerBetter: true  },
];

var ARM_LABELS = {
  'baseline': 'baseline', 'bitemporal': 'bitemporal',
  'ppr': 'ppr', 'ppr-bitemporal': 'ppr+bitemp',
};

function renderQuality(el, ctx, d) {
  var $ = ctx.$;
  var q = d.quality;
  var body = $('qualityBody'), empty = $('qualityEmpty'), meta = $('qualityMeta');

  if (!q || !q.arms || !q.arms.length) {
    if (body) body.style.display = 'none';
    if (empty) empty.style.display = '';
    if (meta) meta.textContent = 'not run';
    return;
  }
  if (body) body.style.display = '';
  if (empty) empty.style.display = 'none';

  var realVault = q.mode === 'real-vault';
  if (meta) meta.textContent = 'eval: ' + (q.mode || '—') + ' · ' + ctx.fmt.fmtAgo(q.ranAt) + ' · k=' + (q.k || '—');

  var arms = q.arms;
  var base = baselineArm(q);
  var grid = $('armCompare');
  if (grid) {
    grid.style.setProperty('--arm-cols', String(arms.length));

    var html = '';
    // Header row: blank label cell + one head per arm.
    html += '<div class="ac-metric" aria-hidden="true"></div>';
    arms.forEach(function (a) {
      html += '<div class="ac-head">' + (ARM_LABELS[a.arm] || a.arm) + '</div>';
    });

    // Metric rows. real-vault mode: only recall@k applies; skip PIT/leak rows.
    var metrics = realVault ? METRICS.slice(0, 1) : METRICS;
    metrics.forEach(function (m) {
      html += '<div class="ac-metric">' + m.label + (m.lowerBetter ? ' <span class="card-sub" style="margin:0;text-transform:none;letter-spacing:0">(lower=good)</span>' : '') + '</div>';
      // Max across arms for this metric → bar scale.
      var vals = arms.map(function (a) { return a[m.key] || 0; });
      var max = Math.max.apply(null, [m.lowerBetter ? 0.0001 : 0.0001].concat(vals));
      arms.forEach(function (a) {
        html += qualityCell(a, m, base, max);
      });
    });

    // real-vault carries MRR + latency instead — add them as extra rows.
    if (realVault) {
      html += mrrLatencyRows(arms, base);
    }
    grid.innerHTML = html;
  }

  // Trend across stored runs (only when ≥2 persisted reports exist).
  var hist = d.qualityHistory || [];
  var trendWrap = $('qualityTrend');
  if (hist.length >= 2 && !realVault) {
    if (trendWrap) trendWrap.style.display = '';
    ctx.charts.drawMulti('qualityTrendChart', [
      { points: hist.map(function (h) { return { y: h.recallAtK }; }), color: 'var(--brand)' },
      { points: hist.map(function (h) { return { y: h.pointInTimeAccuracy }; }), color: 'var(--brand-2)' },
      { points: hist.map(function (h) { return { y: h.staleLeakRate }; }), color: 'var(--warn)' },
    ], { normalize: false });
  } else if (trendWrap) {
    trendWrap.style.display = 'none';
  }
}

function qualityCell(arm, m, base, max) {
  var v = arm[m.key] || 0;
  var isBase = arm.arm === 'baseline';
  var barPct = Math.max(2, Math.min(100, (v / max) * 100));
  var cls = 'ac-cell' + (isBase ? ' ac-base' : '');

  var delta = '';
  if (!isBase && base) {
    var diff = v - (base[m.key] || 0);
    // For percentage-point metrics (leak) show pt; else show the raw delta.
    var dir = diff > 0.0005 ? 'up' : diff < -0.0005 ? 'down' : 'flat';
    var text;
    if (m.key === 'staleLeakRate') {
      text = (diff >= 0 ? '+' : '') + Math.round(diff * 100) + 'pt';
    } else {
      text = (diff >= 0 ? '+' : '') + diff.toFixed(2);
    }
    // lowerBetter → invert good/bad semantics.
    delta = '<span class="kpi-delta ' + dir + (m.lowerBetter ? ' invert' : '') + '">' +
      '<span aria-hidden="true">' + (dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→') + '</span>' + text + '</span>';
  } else if (isBase) {
    delta = '<span class="card-sub" style="margin:0">ref</span>';
  }

  return '<div class="' + cls + '">' +
    '<span class="ac-val">' + m.fmt(v) + '</span>' +
    '<div class="ac-bar" style="width:' + barPct.toFixed(1) + '%"></div>' +
    delta +
    '</div>';
}

function mrrLatencyRows(arms, base) {
  var rows = '';
  // MRR (higher better)
  var mrrVals = arms.map(function (a) { return a.mrr || 0; });
  var mrrMax = Math.max.apply(null, [0.0001].concat(mrrVals));
  rows += '<div class="ac-metric">mrr</div>';
  arms.forEach(function (a) {
    rows += qualityCell(a, { key: 'mrr', fmt: F2, lowerBetter: false }, base, mrrMax);
  });
  // Latency (lower better, ms — separate formatter)
  var latVals = arms.map(function (a) { return a.avgLatencyMs || 0; });
  var latMax = Math.max.apply(null, [1].concat(latVals));
  rows += '<div class="ac-metric">latency <span class="card-sub" style="margin:0;text-transform:none;letter-spacing:0">(lower=good)</span></div>';
  arms.forEach(function (a) {
    var v = a.avgLatencyMs || 0;
    var isBase = a.arm === 'baseline';
    var barPct = Math.max(2, Math.min(100, (v / latMax) * 100));
    var delta = '';
    if (!isBase && base) {
      var diff = v - (base.avgLatencyMs || 0);
      var dir = diff > 0.5 ? 'up' : diff < -0.5 ? 'down' : 'flat';
      delta = '<span class="kpi-delta ' + dir + ' invert"><span aria-hidden="true">' +
        (dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→') + '</span>' + (diff >= 0 ? '+' : '') + Math.round(diff) + 'ms</span>';
    } else if (isBase) {
      delta = '<span class="card-sub" style="margin:0">ref</span>';
    }
    rows += '<div class="ac-cell' + (isBase ? ' ac-base' : '') + '">' +
      '<span class="ac-val">' + Math.round(v) + '<span class="card-sub" style="margin:0">ms</span></span>' +
      '<div class="ac-bar" style="width:' + barPct.toFixed(1) + '%"></div>' + delta + '</div>';
  });
  return rows;
}

// ── Bitemporal KG ───────────────────────────────────────────────────────────

function renderBitemporal(el, ctx, d) {
  var $ = ctx.$;
  var b = d.bitemporal || { enabled: false, active: 0, superseded: 0, recentSupersessions: [] };

  setHtml($, 'bitemporalPill', b.enabled ? pillHtml('ok', 'as-of on') : pillHtml('muted', 'dormant'));
  setText($, 'bitActiveBadge', 'Active: ' + ctx.fmt.fmt(b.active));
  setText($, 'bitSupersededBadge', 'Superseded: ' + ctx.fmt.fmt(b.superseded));

  // active-vs-superseded split (active = ok, superseded = muted text tone).
  var bar = $('bitBar');
  if (bar) {
    var total = (b.active || 0) + (b.superseded || 0);
    if (total <= 0) {
      bar.innerHTML = '<div class="seg" style="flex:1;background:var(--line-faint);color:var(--text-dim)">no facts</div>';
    } else {
      var ap = (b.active / total) * 100, sp = (b.superseded / total) * 100;
      bar.innerHTML =
        '<div class="seg" style="flex:0 0 ' + ap.toFixed(1) + '%;background:var(--ok)" title="Active ' + b.active + '">' + (ap >= 12 ? b.active : '') + '</div>' +
        '<div class="seg" style="flex:0 0 ' + sp.toFixed(1) + '%;background:var(--text-mute)" title="Superseded ' + b.superseded + '">' + (sp >= 12 ? b.superseded : '') + '</div>';
    }
  }

  // Validity timeline lanes.
  var lanes = $('bitLanes');
  if (!lanes) return;
  var events = b.recentSupersessions || [];
  if (!b.enabled) {
    lanes.innerHTML = '<div class="empty-msg" style="padding:0">Bitemporal KG is off — enable BITEMPORAL_KG to stamp validity windows.</div>';
    return;
  }
  if (!events.length) {
    lanes.innerHTML = '<div class="empty-msg" style="padding:0">No supersessions recorded.</div>';
    return;
  }
  lanes.innerHTML = events.slice(0, 8).map(function (ev) {
    return validityLane(ctx, ev);
  }).join('');
}

function validityLane(ctx, ev) {
  var esc = ctx.esc;
  var fact = esc((ev.subject || '') + ' · ' + (ev.predicate || ''));
  var oldObj = esc(String(ev.oldObject == null ? '' : ev.oldObject));
  var newObj = esc(String(ev.newObject == null ? '' : ev.newObject));
  var ts = ev.supersededAt || ev.validTo;
  var ago = ts ? ctx.fmt.fmtAgo(ts) : '—';
  // Inline SVG span: a filled validity bar up to valid_to then the ► marker.
  var track =
    '<svg viewBox="0 0 100 10" preserveAspectRatio="none" width="100%" height="10" aria-hidden="true">' +
    '<rect x="0" y="3.5" width="72" height="3" rx="1.5" fill="var(--ok)"/>' +
    '<rect x="72" y="3.5" width="26" height="3" rx="1.5" fill="var(--line-faint)"/>' +
    '<circle cx="72" cy="5" r="2.4" fill="var(--warn)"/>' +
    '</svg>';
  var title = escAttrOf(ctx,
    (ev.validFrom ? 'valid from ' + ev.validFrom : 'valid from ?') +
    (ev.validTo ? ' · closed ' + ev.validTo : '') +
    (ev.supersededAt ? ' · recorded ' + ev.supersededAt : ''));
  return '<div class="validity-lane" title="' + title + '">' +
    '<span class="vl-fact" title="' + fact + '">' + fact + '</span>' +
    '<span class="mono" style="color:var(--text-dim);flex-shrink:0">' + oldObj + '</span>' +
    '<span class="vl-track">' + track + '</span>' +
    '<span class="vl-arrow" aria-hidden="true">►</span>' +
    '<span class="vl-new">' + newObj + '</span>' +
    '<span class="vl-ts">' + esc(ago) + '</span>' +
    '</div>';
}

function escAttrOf(ctx, s) { return ctx.escAttr(s); }

// ── Graph Recall ────────────────────────────────────────────────────────────

function renderGraph(el, ctx, d) {
  var $ = ctx.$, fmt = ctx.fmt;
  var g = d.graph || { enabled: false, nodes: 0, edges: 0, bridgeTriples: 0, avgDegree: 0, lastSeedSpread: null };

  setHtml($, 'graphPprPill', g.enabled ? pillHtml('ok', 'ppr active') : pillHtml('muted', 'ppr dormant'));
  setText($, 'grNodes', fmt.fmt(g.nodes));
  setText($, 'grEdges', fmt.fmt(g.edges));
  setText($, 'grBridges', fmt.fmt(g.bridgeTriples));
  setText($, 'grAvgDeg', (g.avgDegree == null ? 0 : g.avgDegree).toFixed(1));

  var spread = $('grSpread');
  var qLabel = $('grSeedQuery');
  var ss = g.lastSeedSpread;

  if (!g.enabled) {
    if (qLabel) qLabel.textContent = '';
    if (spread) spread.innerHTML = '<div class="empty-msg" style="padding:0">Dormant — enable PPR_RECALL to rank over the graph and see reach.</div>';
    return;
  }
  if (!ss) {
    if (qLabel) qLabel.textContent = '';
    if (spread) spread.innerHTML = '<div class="empty-msg" style="padding:0">No PPR query recorded yet.</div>';
    return;
  }
  if (qLabel) qLabel.textContent = '"' + (ss.query || '') + '"';
  if (spread) spread.innerHTML = seedSpreadGlyph(ss);
}

/**
 * Honest seed→spread glyph: concentric rings whose dot counts are the ACTUAL
 * reachable-set sizes at 1/2/3 hops (not a decorative network). Seeds at centre
 * in brand violet; hops fade toward the muted end.
 */
function seedSpreadGlyph(ss) {
  var rings = [
    { label: 'seeds', n: ss.seeds || 0, r: 0,  color: 'var(--brand)' },
    { label: '1-hop', n: ss.hop1 || 0,  r: 26, color: 'var(--brand-2)' },
    { label: '2-hop', n: ss.hop2 || 0,  r: 46, color: 'var(--info)' },
    { label: '3-hop', n: ss.hop3 || 0,  r: 66, color: 'var(--text-dim)' },
  ];
  var cx = 80, cy = 80;
  var svg = '<svg viewBox="0 0 160 160" width="150" height="150" role="img" aria-label="PPR reachable-set sizes by hop">';
  // faint ring guides
  rings.forEach(function (ring) {
    if (ring.r > 0) svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ring.r + '" fill="none" stroke="var(--line-faint)"/>';
  });
  // dots per ring — count dots up to a cap, sized to hint magnitude
  rings.forEach(function (ring) {
    var dots = Math.min(ring.n, ring.r === 0 ? 3 : 12);
    if (ring.r === 0) {
      // seeds cluster at centre
      for (var s = 0; s < Math.max(1, dots); s++) {
        var ox = dots > 1 ? (s - (dots - 1) / 2) * 7 : 0;
        svg += '<circle cx="' + (cx + ox) + '" cy="' + cy + '" r="3.5" fill="' + ring.color + '"/>';
      }
    } else {
      for (var i = 0; i < dots; i++) {
        var a = (i / dots) * Math.PI * 2 - Math.PI / 2;
        var x = cx + ring.r * Math.cos(a), y = cy + ring.r * Math.sin(a);
        svg += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.4" fill="' + ring.color + '"/>';
      }
    }
  });
  svg += '</svg>';

  var legend = '<div style="display:flex;flex-direction:column;gap:.3rem;justify-content:center">' +
    rings.map(function (ring) {
      return '<div style="display:flex;align-items:center;gap:.4rem;font-size:var(--fs-sm)">' +
        '<i style="width:9px;height:9px;border-radius:50%;background:' + ring.color + ';display:inline-block"></i>' +
        '<span style="color:var(--text-dim)">' + ring.label + '</span>' +
        '<span class="mono" style="color:var(--text);margin-left:auto;font-feature-settings:var(--num)">' + ring.n + '</span>' +
        '</div>';
    }).join('') + '</div>';

  return '<div style="display:flex;gap:1rem;align-items:center">' +
    '<div style="flex-shrink:0">' + svg + '</div>' + legend + '</div>';
}

// ── tiny DOM helpers (avoid setLive flash on innerHTML sinks) ─────────────────

function setText($, id, text) {
  var el = $(id);
  if (el) el.textContent = text == null ? '' : String(text);
}
function setHtml($, id, html) {
  var el = $(id);
  if (el) el.innerHTML = html == null ? '' : html;
}
