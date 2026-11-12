// lab.js — Recall Lab tab (ES module, no build).
//
// Three views behind a segmented control, each deep-linkable:
//   #lab/playground[/<query>]  run memory_recall (explain, no-touch) + read why
//   #lab/wakeup                inspect what memory_wakeup would inject
//   #lab/eval                  eval run history, trends, regressions vs baseline
// Data comes from /dashboard/api/{recall,wakeup,eval/*} on demand — nothing
// here rides the SSE payload, so refresh() is a no-op.

/** @typedef {import('../core.js').Ctx} Ctx */

var VIEWS = ['playground', 'wakeup', 'eval'];
var current = 'playground';
var lastQuery = '';
var wakeOptsLoaded = false;
var evalLoaded = false;
var evalRuns = [];

export default {
  id: 'lab',

  init(el, ctx) {
    el.querySelectorAll('[data-lab-view]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-lab-view');
        showView(el, ctx, v);
        ctx.setRoute(v === 'playground' && lastQuery ? 'playground/' + lastQuery : v);
      });
    });
    // Arrow-key roving between the segmented buttons (tablist pattern).
    var seg = ctx.$('labSeg');
    seg.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      var i = VIEWS.indexOf(current);
      var n = VIEWS[(i + (ev.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
      showView(el, ctx, n);
      ctx.setRoute(n, true);
      var btn = seg.querySelector('[data-lab-view="' + n + '"]');
      if (btn) btn.focus();
    });

    ctx.$('labRecallForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var q = ctx.$('labQuery').value.trim();
      if (!q) return;
      ctx.setRoute('playground/' + q);
      runRecall(ctx, q);
    });
    ctx.$('labWakeForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      loadWakeup(ctx);
    });
    ctx.$('evalReload').addEventListener('click', function () { loadEval(ctx); });
    ctx.$('evalCat').addEventListener('change', function () { renderTrends(ctx); });
    ctx.$('evalBase').addEventListener('change', function () { loadCompare(ctx); });
    ctx.$('evalRun').addEventListener('change', function () { loadCompare(ctx); });
  },

  /** Hash route: `<view>[/<arg>]`. */
  route(el, ctx, rest) {
    var parts = (rest || '').split('/');
    var view = VIEWS.indexOf(parts[0]) >= 0 ? parts[0] : 'playground';
    showView(el, ctx, view);
    if (view === 'playground') {
      var q = parts.slice(1).join('/');
      if (q && q !== lastQuery) {
        ctx.$('labQuery').value = q;
        runRecall(ctx, q);
      }
    }
  },

  refresh() {},
};

function showView(el, ctx, view) {
  current = view;
  el.querySelectorAll('[data-lab-view]').forEach(function (b) {
    var on = b.getAttribute('data-lab-view') === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.setAttribute('tabindex', on ? '0' : '-1');
  });
  ctx.$('labPlayground').hidden = view !== 'playground';
  ctx.$('labWakeup').hidden = view !== 'wakeup';
  ctx.$('labEval').hidden = view !== 'eval';
  if (view === 'wakeup' && !wakeOptsLoaded) { wakeOptsLoaded = true; loadWakeOptions(ctx); loadWakeup(ctx); }
  if (view === 'eval' && !evalLoaded) { evalLoaded = true; loadEval(ctx); }
}

function pct(v) { return Math.round(Math.max(0, Math.min(1, v || 0)) * 100); }
function f3(v) { return v == null ? '—' : (Math.round(v * 1000) / 1000).toString(); }
function noteHref(path) { return '#memories/' + String(path).split('/').map(encodeURIComponent).join('/'); }

// ── Playground ───────────────────────────────────────────────────────────────

function formParams(q) {
  var p = new URLSearchParams();
  p.set('query', q);
  [['limit', 'labLimit'], ['categories', 'labCategory'], ['temperature', 'labTemp'],
   ['minImportance', 'labImp'], ['relatedTo', 'labRelated'], ['dateFrom', 'labFrom'], ['dateTo', 'labTo']]
    .forEach(function (pair) {
      var el = document.getElementById(pair[1]);
      var v = el && el.value ? el.value.trim() : '';
      if (v && !(pair[0] === 'temperature' && v === 'any')) p.set(pair[0], v);
    });
  return p.toString();
}

function runRecall(ctx, q) {
  lastQuery = q;
  var out = ctx.$('labResults');
  var meta = ctx.$('labResultsMeta');
  var btn = ctx.$('labRunBtn');
  btn.disabled = true;
  meta.textContent = 'Recalling…';
  out.setAttribute('aria-busy', 'true');
  ctx.fetchJson('/dashboard/api/recall?' + formParams(q))
    .then(function (d) {
      var rs = d.results || [];
      meta.innerHTML = '<b>' + rs.length + '</b> result' + (rs.length === 1 ? '' : 's') +
        ' for <span class="mono">' + ctx.esc(d.query) + '</span> in ' + d.tookMs + ' ms';
      out.innerHTML = rs.length ? rs.map(function (r) { return hitHtml(ctx, r); }).join('')
        : '<div class="empty"><div class="empty-title">No memories matched</div>' +
          '<div class="empty-msg" style="padding:0">Recall only returns notes of type memory. Loosen the filters or try other words.</div></div>';
    })
    .catch(function (e) {
      meta.textContent = '';
      out.innerHTML = '<div class="state-error" role="alert">Recall failed: ' + ctx.esc(e.message) + '</div>';
    })
    .finally(function () { btn.disabled = false; out.removeAttribute('aria-busy'); });
}

function hitHtml(ctx, r) {
  var esc = ctx.esc;
  var tempCls = r.temperature === 'hot' ? 'badge-hot' : r.temperature === 'warm' ? 'badge-warm' : 'badge-cold';
  var bars = r.bars.map(function (b) {
    var na = b.value == null;
    var cls = 'sig-fill sig-' + b.key + (b.negative && b.value > 0 ? ' sig-neg' : '');
    return '<div class="sig-row">'
      + '<span class="sig-label">' + esc(b.label) + '</span>'
      + '<span class="sig-track" aria-hidden="true">' + (na ? '<span class="sig-na"></span>'
        : b.value > 0 ? '<span class="' + cls + '" style="width:' + Math.max(pct(b.value), 2) + '%"></span>' : '') + '</span>'
      + '<span class="sig-val">' + esc(b.text) + '</span>'
      + '</div>';
  }).join('');
  var obs = ctx.obsidianLink(r.path);
  return '<article class="lab-hit" aria-label="Result ' + r.rank + ': ' + ctx.escAttr(r.title) + '">'
    + '<header class="lab-hit-head">'
    + '<span class="lab-rank" aria-hidden="true">' + r.rank + '</span>'
    + '<div class="lab-hit-title"><a href="' + ctx.escAttr(noteHref(r.path)) + '">' + esc(r.title) + '</a>'
    + '<div class="card-sub mono lab-path">' + esc(r.path) + '</div></div>'
    + '<div class="lab-hit-meta">'
    + '<span class="badge ' + tempCls + '">' + esc(r.temperature) + '</span>'
    + '<span class="badge badge--muted">' + esc(r.category) + '</span>'
    + (r.archived ? '<span class="badge badge--warn">archived</span>' : '')
    + '<span class="lab-score mono" title="Final rank score">score ' + f3(r.score) + '</span>'
    + '</div></header>'
    + (r.reason ? '<p class="lab-reason"><span class="lab-why">Why:</span> ' + esc(r.reason) + '</p>' : '')
    + '<div class="sig-grid" role="group" aria-label="Ranking signals">' + bars + '</div>'
    + (obs ? '<div class="lab-hit-foot">' + obs + '</div>' : '')
    + '</article>';
}

// ── Wakeup inspector ─────────────────────────────────────────────────────────

function loadWakeOptions(ctx) {
  ctx.fetchJson('/dashboard/api/wakeup/options').then(function (o) {
    ctx.$('wkAgentList').innerHTML = (o.agents || []).map(function (a) { return '<option value="' + ctx.escAttr(a) + '">'; }).join('');
    ctx.$('wkProjectList').innerHTML = (o.projects || []).map(function (a) { return '<option value="' + ctx.escAttr(a) + '">'; }).join('');
  }).catch(function () { /* options are a convenience */ });
}

function loadWakeup(ctx) {
  var p = new URLSearchParams();
  p.set('preset', ctx.$('wkPreset').value);
  if (ctx.$('wkAgent').value.trim()) p.set('agent', ctx.$('wkAgent').value.trim());
  if (ctx.$('wkProject').value.trim()) p.set('project', ctx.$('wkProject').value.trim());
  var box = ctx.$('wkLayers');
  box.setAttribute('aria-busy', 'true');
  ctx.fetchJson('/dashboard/api/wakeup?' + p.toString())
    .then(function (d) { renderWakeup(ctx, d); })
    .catch(function (e) { box.innerHTML = '<div class="state-error" role="alert">Wakeup preview failed: ' + ctx.esc(e.message) + '</div>'; })
    .finally(function () { box.removeAttribute('aria-busy'); });
}

function renderWakeup(ctx, d) {
  var esc = ctx.esc;
  var budget = d.budget || 1;
  ctx.$('wkTotal').textContent = d.budgetTokens + ' / ' + budget + ' tokens in budget · ' + d.totalTokens + ' total';
  var rows = (d.layers || []).map(function (l, i) {
    var w = pct(l.tokens / budget);
    var over = l.rawTokens > l.tokens;
    return '<div class="wk-layer">'
      + '<div class="wk-layer-head"><span class="wk-layer-name">' + esc(l.label) + '</span>'
      + '<span class="mono wk-layer-tok">' + l.tokens + ' tok' + (l.inBudget ? ' · ' + w + '% of budget' : ' · outside L0+L1 budget') + '</span>'
      + (over ? '<span class="pill pill--warn">truncated from ' + l.rawTokens + '</span>' : '')
      + '</div>'
      + '<div class="wk-track" aria-hidden="true"><span class="wk-fill' + (l.inBudget ? '' : ' wk-fill--extra') + '" style="width:' + Math.min(w, 100) + '%"></span></div>'
      + '<details class="wk-content"><summary>Show injected text</summary><pre class="md-pre">' + esc(l.content || '(empty)') + '</pre></details>'
      + '</div>';
  });
  ctx.$('wkLayers').innerHTML = rows.length ? rows.join('')
    : '<div class="empty-msg" style="padding:0">wakeUp returned no layers.</div>';

  var notes = d.l1Notes || [];
  ctx.$('wkNotesCount').textContent = notes.length + ' note' + (notes.length === 1 ? '' : 's');
  ctx.$('wkNotes').innerHTML = notes.length ? '<ol class="wk-notes">' + notes.map(function (n) {
    return '<li><a href="' + ctx.escAttr(noteHref(n.path)) + '">' + esc(n.title) + '</a>'
      + ' <span class="card-sub mono">' + esc([n.category, n.temperature, n.heat != null ? 'heat ' + f3(n.heat) : ''].filter(Boolean).join(' · ')) + '</span>'
      + ' ' + ctx.obsidianLink(n.path, 'Obsidian') + '</li>';
  }).join('') + '</ol>' : '<div class="empty-msg" style="padding:0">L1 links no notes (empty vault or no memories yet).</div>';
}

// ── Eval ─────────────────────────────────────────────────────────────────────

function loadEval(ctx) {
  ctx.fetchJson('/dashboard/api/eval/runs').then(function (d) {
    evalRuns = d.runs || [];
    ctx.$('evalDir').innerHTML = 'Results directory: <span class="mono">' + ctx.esc(d.dir || '?') + '</span> · ' + evalRuns.length + ' run' + (evalRuns.length === 1 ? '' : 's');
    var empty = evalRuns.length === 0;
    ctx.$('evalEmpty').hidden = !empty;
    ctx.$('evalBody').hidden = empty;
    ctx.$('evalHistory').innerHTML = empty ? '' : historyTable(ctx);
    if (empty) return;
    var cats = {};
    evalRuns.forEach(function (r) { Object.keys(r.categories || {}).forEach(function (c) { cats[c] = 1; }); });
    ctx.$('evalCat').innerHTML = '<option value="">overall</option>' + Object.keys(cats).sort().map(function (c) {
      return '<option value="' + ctx.escAttr(c) + '">' + ctx.esc(c) + '</option>';
    }).join('');
    var opts = evalRuns.slice().reverse().map(function (r) {
      return '<option value="' + ctx.escAttr(r.id) + '">' + ctx.esc(r.label + ' · ' + shortTs(r.ts)) + '</option>';
    }).join('');
    ctx.$('evalRun').innerHTML = opts;
    ctx.$('evalBase').innerHTML = opts;
    if (evalRuns.length > 1) ctx.$('evalBase').selectedIndex = 1;
    renderTrends(ctx);
    loadCompare(ctx);
  }).catch(function (e) {
    ctx.$('evalHistory').innerHTML = '<div class="state-error" role="alert">Could not read eval runs: ' + ctx.esc(e.message) + '</div>';
  });
}

function shortTs(ts) {
  var d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function metricCell(v, prev, kind) {
  if (v == null) return '<td class="num">—</td>';
  var txt = kind === 'ms' ? Math.round(v) + ' ms' : kind === 'pct' ? (v * 100).toFixed(1) + '%' : v.toFixed(3);
  var delta = '';
  if (prev != null) {
    var dlt = v - prev;
    var better = kind === 'ms' ? dlt < 0 : dlt > 0;
    if (Math.abs(dlt) > 1e-9) {
      var dTxt = kind === 'ms' ? Math.round(dlt) + ' ms' : kind === 'pct' ? (dlt * 100).toFixed(1) + ' pt' : dlt.toFixed(3);
      delta = ' <span class="kpi-delta ' + (better ? 'up' : 'down') + '"><span aria-hidden="true">' + (dlt > 0 ? '↑' : '↓') + '</span>'
        + (dlt > 0 ? '+' : '') + dTxt + '<span class="sr-only">' + (better ? ' better' : ' worse') + '</span></span>';
    }
  }
  return '<td class="num">' + txt + delta + '</td>';
}

function historyTable(ctx) {
  var rows = evalRuns.slice().reverse().map(function (r, i, arr) {
    var prev = arr[i + 1];
    var o = r.overall || {}, po = prev ? prev.overall || {} : {};
    return '<tr><td>' + ctx.esc(shortTs(r.ts)) + '</td><td class="mono">' + ctx.esc(r.label) + '</td>'
      + metricCell(o.recallAt5, prev ? po.recallAt5 : null, 'pct')
      + metricCell(o.mrr, prev ? po.mrr : null, 'num')
      + metricCell(o.p95Ms, prev ? po.p95Ms : null, 'ms')
      + '<td class="num">' + (o.n != null ? o.n : r.queryCount) + '</td></tr>';
  }).join('');
  return '<div class="table-wrap"><table><caption class="sr-only">Eval runs, newest first, with change versus the previous run</caption>'
    + '<thead><tr><th scope="col">When</th><th scope="col">Run</th><th scope="col">Recall@5</th><th scope="col">MRR</th><th scope="col">p95</th><th scope="col">Queries</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table></div>';
}

function renderTrends(ctx) {
  var cat = ctx.$('evalCat').value;
  var series = evalRuns.map(function (r) { return cat ? (r.categories || {})[cat] || {} : r.overall || {}; });
  [['recallAt5', 'evalTrendR5', 'var(--brand)', 'pct'], ['mrr', 'evalTrendMrr', 'var(--brand-2)', 'num'], ['p95Ms', 'evalTrendP95', 'var(--warn)', 'ms']]
    .forEach(function (m) {
      var vals = series.map(function (s) { return s[m[0]]; }).filter(function (v) { return v != null; });
      var fmtV = function (v) { return m[3] === 'pct' ? (v * 100).toFixed(1) + '%' : m[3] === 'ms' ? Math.round(v) + ' ms' : v.toFixed(3); };
      var txt = vals.length === 0 ? 'no data' : vals.length === 1 ? fmtV(vals[0]) + ' (1 run)'
        : fmtV(vals[0]) + ' → ' + fmtV(vals[vals.length - 1]) + ' over ' + vals.length + ' runs';
      ctx.$(m[1] + 'Txt').textContent = txt;
      // Rescale into 0.1..0.9 so small run-to-run moves are visible (drawChart
      // floors its max at 1); the exact values live in the text line below.
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      ctx.charts.drawChart(m[1], vals.map(function (v) { return { y: hi > lo ? 0.1 + 0.8 * (v - lo) / (hi - lo) : 0.5 }; }), m[2]);
      var svg = ctx.$(m[1]);
      if (svg) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', (cat || 'overall') + ' ' + m[0] + ': ' + txt); }
    });
}

function loadCompare(ctx) {
  var run = ctx.$('evalRun').value, base = ctx.$('evalBase').value;
  var box = ctx.$('evalDiff');
  if (!run || !base) { box.innerHTML = ''; return; }
  if (run === base) {
    ctx.$('evalDiffSummary').textContent = 'Pick two different runs to compare.';
    box.innerHTML = '';
    return;
  }
  ctx.fetchJson('/dashboard/api/eval/compare?run=' + encodeURIComponent(run) + '&baseline=' + encodeURIComponent(base))
    .then(function (d) {
      var diffs = d.diffs || [];
      var count = { regressed: 0, improved: 0, same: 0, new: 0, dropped: 0 };
      diffs.forEach(function (x) { count[x.status]++; });
      ctx.$('evalDiffSummary').innerHTML = '<b>' + count.regressed + '</b> regressed · <b>' + count.improved + '</b> improved · '
        + count.same + ' unchanged' + (count.new ? ' · ' + count.new + ' new' : '') + (count.dropped ? ' · ' + count.dropped + ' dropped' : '');
      var shown = diffs.filter(function (x) { return x.status !== 'same'; });
      if (!shown.length) { box.innerHTML = '<div class="empty-msg" style="padding:0">No per-query changes between these runs.</div>'; return; }
      box.innerHTML = '<div class="table-wrap"><table><caption class="sr-only">Per-query changes, regressions first</caption>'
        + '<thead><tr><th scope="col">Status</th><th scope="col">Query</th><th scope="col">Category</th><th scope="col">Rank (base → run)</th><th scope="col">RR (base → run)</th></tr></thead><tbody>'
        + shown.slice(0, 300).map(function (x) {
          var st = x.status === 'regressed' || x.status === 'dropped' ? 'bad' : x.status === 'improved' ? 'ok' : 'muted';
          return '<tr><td><span class="pill pill--' + st + '">' + x.status + '</span></td>'
            + '<td>' + ctx.esc(x.query || x.key) + '</td><td class="mono">' + ctx.esc(x.category) + '</td>'
            + '<td class="num">' + rankTxt(x.baseRank) + ' → ' + rankTxt(x.curRank) + '</td>'
            + '<td class="num">' + f3(x.baseRr) + ' → ' + f3(x.curRr) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    })
    .catch(function (e) { box.innerHTML = '<div class="state-error" role="alert">' + ctx.esc(e.message) + '</div>'; });
}

function rankTxt(r) { return r == null ? '—' : r > 0 ? '#' + r : 'miss'; }
