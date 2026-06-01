// code.js — Code tab client module (ES module, no build).
// Revamped to the new design system (REVAMP.md §5 TAB 7). Reads only from
// ctx.data.codeNav + ctx.data.codeNavSavings + ctx.data.derived (savingsPerCall
// / savingsRunRate / callResolutionPct). No data-source changes — this is a
// visual + viz upgrade. The flagship overview.js is the reference for the
// KPI / pill / delta / gauge / chart / empty patterns reused here.
// NOTE: real .js file, so unicode escapes are single-backslash (—).

/** @typedef {import('../core.js').Ctx} Ctx */

export default {
  id: 'code',

  /** No one-time wiring needed: this tab is render-only from the SSE payload. */
  init(/* el, ctx */) {},

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    renderCode(ctx);
  },
};

// ── shared helpers (mirrored from overview.js so tabs stay consistent) ───────

function pillHtml(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}

function deltaHtml(tr) {
  if (!tr) return '';
  var dir = tr.dir || 'flat';
  var glyph = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  var pct = Math.abs(tr.pct || 0);
  return '<span class="kpi-delta ' + dir + '"><span aria-hidden="true">' + glyph + '</span>' + pct + '%</span>';
}

function emptyHtml(title, msg) {
  return '<div class="empty">'
    + '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg>'
    + '<div class="empty-title">' + title + '</div>'
    + (msg ? '<div class="empty-msg" style="padding:0">' + msg + '</div>' : '')
    + '</div>';
}

/** Mirror of model/derive THRESHOLDS.callResolutionPct (higher = better). */
function resolutionState(v01) {
  if (v01 >= 0.9) return 'ok';
  if (v01 >= 0.7) return 'warn';
  return 'bad';
}

// ── render ────────────────────────────────────────────────────────────────

function renderCode(ctx) {
  var $ = ctx.$, fmt = ctx.fmt, setLive = ctx.setLive;
  var dv = ctx.data.derived || {};
  var cn = ctx.data.codeNav || null;

  // Index footprint KPI + per-repo table.
  if (!cn) {
    setLive('codeSymbolCount', '0');
    if ($('codeFootprintSub')) $('codeFootprintSub').textContent = 'index not registered';
    if ($('codeCallStats')) $('codeCallStats').textContent = '0 / 0 calls resolved';
    setLive('codeResolutionVal', '—');
    if ($('codeResolutionPill')) $('codeResolutionPill').innerHTML = pillHtml('muted', 'no calls');
    ctx.charts.drawGauge('codeResolutionGauge', 0, { label: '—', color: 'var(--text-mute)' });
    var tbEmpty = $('codeRepoTable');
    if (tbEmpty) tbEmpty.innerHTML = emptyRow(5, 'No repositories indexed', 'Use code_repo_register / code_repo_scan to build the symbol index.');
  } else {
    var symbols = cn.symbolCount || 0;
    var files = cn.fileCount || 0;
    setLive('codeSymbolCount', fmt.fmt(symbols));
    if ($('codeFootprintSub')) {
      var spf = files > 0 ? (symbols / files) : 0;
      $('codeFootprintSub').textContent = fmt.fmt(cn.repoCount || 0) + ' repos · '
        + fmt.fmt(files) + ' files · ' + fmt.fmtBytes(cn.dbSizeBytes) + ' db';
      void spf;
    }

    // Call-resolution KPI: gauge + pill from derived.callResolutionPct.
    var resolved = (cn.callCount && cn.callCount.resolved) || 0;
    var unresolved = (cn.callCount && cn.callCount.unresolved) || 0;
    var totalCalls = resolved + unresolved;
    var resPct = dv.callResolutionPct != null
      ? dv.callResolutionPct
      : (totalCalls > 0 ? resolved / totalCalls : 0);
    setLive('codeResolutionVal', totalCalls > 0 ? Math.round(resPct * 100) + '%' : '—');
    if ($('codeCallStats')) $('codeCallStats').textContent = fmt.fmt(resolved) + ' / ' + fmt.fmt(totalCalls) + ' calls resolved';
    if ($('codeResolutionPill')) {
      if (totalCalls === 0) $('codeResolutionPill').innerHTML = pillHtml('muted', 'no calls');
      else {
        var st = resolutionState(resPct);
        $('codeResolutionPill').innerHTML = pillHtml(st, st === 'ok' ? 'clean graph' : st === 'warn' ? 'some dangling' : 'dangling symbols');
      }
    }
    ctx.charts.drawGauge('codeResolutionGauge', totalCalls > 0 ? resPct : 0, {
      label: totalCalls > 0 ? Math.round(resPct * 100) + '%' : '—',
      good: 0.9, warn: 0.7,
    });

    renderRepoTable(ctx, cn.perRepo || []);
  }

  renderCodeSavings(ctx);
  renderSoWhat(ctx, cn, dv);
}

function renderRepoTable(ctx, perRepo) {
  var $ = ctx.$, fmt = ctx.fmt, esc = ctx.esc;
  var tb = $('codeRepoTable');
  if (!tb) return;
  if (!perRepo.length) {
    tb.innerHTML = emptyRow(5, 'No repositories indexed', 'Use code_repo_register / code_repo_scan.');
    return;
  }
  var now = Date.now();
  // Stale = not indexed in > 7 days (matches the "9d stale" framing in the spec).
  var STALE_MS = 7 * 86400000;
  tb.innerHTML = perRepo.map(function (r) {
    var symbols = r.symbols || 0, files = r.files || 0;
    var density = files > 0 ? (symbols / files).toFixed(1) : '—';
    var ts = r.lastIndexedAt || 0;
    var stale = ts > 0 && (now - ts) > STALE_MS;
    var dot = ts === 0
      ? '<span class="cell-dot" style="background:var(--text-mute)" title="never indexed"></span>'
      : '<span class="cell-dot" style="background:' + (stale ? 'var(--warn)' : 'var(--ok)') + '" title="' + (stale ? 'stale' : 'fresh') + '"></span>';
    return '<tr>'
      + '<td>' + esc(r.slug) + '</td>'
      + '<td class="num">' + fmt.fmt(symbols) + '</td>'
      + '<td class="num">' + fmt.fmt(files) + '</td>'
      + '<td class="num">' + density + '</td>'
      + '<td>' + dot + (ts ? fmt.fmtAgo(ts) : 'never') + '</td>'
      + '</tr>';
  }).join('');
}

function renderCodeSavings(ctx) {
  var $ = ctx.$, fmt = ctx.fmt, esc = ctx.esc, setLive = ctx.setLive;
  var dv = ctx.data.derived || {};
  var sv = ctx.data.codeNavSavings || null;

  var summary = $('codeSavingsSummary');
  var tb = $('codeSavingsTable');
  var rb = $('codeSavingsRepoTable');
  var bars = $('codeByToolBars');

  if (!sv || !sv.totalCalls) {
    setLive('codeSavingsTotal', '0');
    if ($('codeSavingsSub')) $('codeSavingsSub').textContent = 'no code-nav calls yet';
    if ($('codeSavingsDelta')) $('codeSavingsDelta').innerHTML = '';
    setLive('codeAvgPerCall', '0');
    if ($('codeCallsSub')) $('codeCallsSub').textContent = '0 calls';
    if ($('codeRunRate')) $('codeRunRate').textContent = '—';
    if (summary) summary.textContent = 'No code-nav tool calls recorded yet.';
    ctx.charts.drawChart('codeSavingsTrend', [], 'var(--brand)');
    ctx.charts.drawChart('codeSavingsChart', [], 'var(--brand)');
    if (tb) tb.innerHTML = emptyRow(4, 'No savings recorded', 'Call code_symbol_search / code_file_outline / etc. to populate.');
    if (rb) rb.innerHTML = emptyRow(4, 'No per-repo data', 'Multi-repo or unattributed calls only.');
    if (bars) bars.innerHTML = emptyHtml('No tool savings', '');
    return;
  }

  // KPI 1 — Tokens Saved (headline) + run-rate sub + trend delta.
  setLive('codeSavingsTotal', fmt.fmt(sv.totalSaved));
  // $0.003 / 1k tokens — Claude Sonnet input pricing (rough baseline).
  var costUsd = (sv.totalSaved / 1000) * 0.003;
  var runRate = dv.savingsRunRate || 0;
  if ($('codeSavingsSub')) $('codeSavingsSub').textContent = '~' + fmt.fmt(runRate) + '/day · ~$' + costUsd.toFixed(2) + ' saved';
  if ($('codeSavingsDelta')) {
    // Trend of cumulative savings over the history window.
    var hist = sv.history || [];
    if (hist.length >= 2) {
      $('codeSavingsDelta').innerHTML = deltaHtml(trendOf(hist.map(function (h) { return h.cumulativeSaved; })));
    } else $('codeSavingsDelta').innerHTML = '';
  }

  // KPI 2 — Avg / Call.
  var avgPerCall = dv.savingsPerCall != null
    ? dv.savingsPerCall
    : (sv.totalCalls > 0 ? Math.round(sv.totalSaved / sv.totalCalls) : 0);
  setLive('codeAvgPerCall', fmt.fmt(avgPerCall));
  if ($('codeCallsSub')) $('codeCallsSub').textContent = fmt.fmt(sv.totalCalls) + ' calls';

  // Run-rate badge on the cumulative-savings card head.
  if ($('codeRunRate')) $('codeRunRate').textContent = runRate ? ('~' + fmt.fmt(runRate) + ' tokens/day') : 'rate pending';

  // Long-form summary line under the chart.
  if (summary) {
    summary.innerHTML = 'Total tokens saved: <strong>' + fmt.fmt(sv.totalSaved)
      + '</strong> across <strong>' + fmt.fmt(sv.totalCalls) + '</strong> calls '
      + '(≈ $' + costUsd.toFixed(2) + ' at Claude Sonnet input pricing — approximate).';
  }

  // Charts — real cumulative-savings area (Band C) + KPI sparkline (Band B),
  // both from codeNavSavings.history[]. (replaces the legacy ASCII bar chart.)
  var points = (sv.history || []).map(function (h) { return { y: h.cumulativeSaved }; });
  ctx.charts.drawChart('codeSavingsTrend', points, 'var(--brand)');
  ctx.charts.drawChart('codeSavingsChart', points, 'var(--brand)');

  // By-tool savings → Pareto ranking bars (the ranking IS the insight).
  var byTool = sv.savedByTool || {};
  var toolNames = Object.keys(byTool).sort(function (a, b) {
    return byTool[b].tokensSaved - byTool[a].tokensSaved;
  });
  if (bars) {
    if (!toolNames.length) {
      bars.innerHTML = emptyHtml('No tool savings', '');
    } else {
      var maxTool = byTool[toolNames[0]].tokensSaved || 1;
      bars.innerHTML = toolNames.slice(0, 8).map(function (name) {
        var t = byTool[name];
        var pct = Math.max(2, (t.tokensSaved / maxTool) * 100).toFixed(1);
        return '<div class="cat-row">'
          + '<span class="cat-label" title="' + esc(name) + '">' + esc(shortTool(name)) + '</span>'
          + '<div class="cat-bar-wrap"><div class="cat-bar" style="width:' + pct + '%;background:var(--brand-grad)">'
          + fmt.fmt(t.tokensSaved) + '</div></div>'
          + '<span class="cat-count">' + fmt.fmt(t.calls) + '</span>'
          + '</div>';
      }).join('');
    }
  }

  // Drill-down table: by tool.
  if (tb) {
    tb.innerHTML = toolNames.map(function (name) {
      var t = byTool[name];
      return '<tr>'
        + '<td>' + esc(name) + '</td>'
        + '<td class="num">' + fmt.fmt(t.calls) + '</td>'
        + '<td class="num">' + fmt.fmt(t.tokensSaved) + '</td>'
        + '<td class="num">' + fmt.fmt(t.avgSaved) + '</td>'
        + '</tr>';
    }).join('');
  }

  // Drill-down table: by repo (best-effort attribution).
  if (rb) {
    var byRepo = sv.savedByRepo || {};
    var repos = Object.keys(byRepo).sort(function (a, b) {
      return byRepo[b].tokensSaved - byRepo[a].tokensSaved;
    });
    if (!repos.length) {
      rb.innerHTML = emptyRow(4, 'No per-repo data', 'Multi-repo or unattributed calls only.');
    } else {
      rb.innerHTML = repos.map(function (slug) {
        var r = byRepo[slug];
        return '<tr>'
          + '<td>' + esc(slug) + '</td>'
          + '<td class="num">' + fmt.fmt(r.calls) + '</td>'
          + '<td class="num">' + fmt.fmt(r.tokensSaved) + '</td>'
          + '<td class="num">' + fmt.fmt(r.avgSaved) + '</td>'
          + '</tr>';
      }).join('');
    }
  }
}

function renderSoWhat(ctx, cn, dv) {
  var sw = ctx.$('codeSoWhat');
  if (!sw) return;
  var sv = ctx.data.codeNavSavings || null;
  var fmt = ctx.fmt, esc = ctx.esc;
  if (!sv || !sv.totalCalls) {
    sw.innerHTML = 'No code-nav activity yet — savings accrue once <b>code_*</b> tools run against an indexed repo.';
    return;
  }
  var runRate = dv.savingsRunRate || 0;
  var resPct = dv.callResolutionPct != null ? dv.callResolutionPct : 0;
  var staleRepo = staleRepoSummary(cn, fmt);
  sw.innerHTML = 'Saved <b>' + fmt.fmt(sv.totalSaved) + '</b> tokens'
    + (runRate ? ' (~<b>' + fmt.fmt(runRate) + '</b>/day)' : '')
    + ' · <b>' + Math.round(resPct * 100) + '%</b> resolution'
    + (staleRepo ? ' · ' + esc(staleRepo) : '');
}

// ── small utilities ──────────────────────────────────────────────────────

function emptyRow(cols, title, msg) {
  return '<tr><td colspan="' + cols + '" style="padding:0">' + emptyHtml(title, msg) + '</td></tr>';
}

/** Shorten a code-nav tool name for the narrow bar label (drops the prefix). */
function shortTool(name) {
  var s = String(name);
  return s.replace(/^code[_-]/, '').replace(/^mcp__[^_]+__/, '');
}

/** Sign-of-slope trend over a numeric series (mirrors model/derive trend dir). */
function trendOf(values) {
  if (!values || values.length < 2) return { dir: 'flat', pct: 0 };
  var first = values[0], last = values[values.length - 1];
  var dir = last > first ? 'up' : last < first ? 'down' : 'flat';
  var pct = first === 0 ? (last === 0 ? 0 : 100) : Math.round(((last - first) / Math.abs(first)) * 1000) / 10;
  return { dir: dir, pct: pct };
}

/** "repo-x 9d stale" — the most-stale indexed repo, if any is > 7d old. */
function staleRepoSummary(cn, fmt) {
  if (!cn || !cn.perRepo || !cn.perRepo.length) return '';
  var now = Date.now();
  var STALE_MS = 7 * 86400000;
  var worst = null;
  cn.perRepo.forEach(function (r) {
    if (!r.lastIndexedAt) return;
    if ((now - r.lastIndexedAt) <= STALE_MS) return;
    if (!worst || r.lastIndexedAt < worst.lastIndexedAt) worst = r;
  });
  if (!worst) return '';
  return worst.slug + ' ' + fmt.fmtAgo(worst.lastIndexedAt) + ' stale';
}
