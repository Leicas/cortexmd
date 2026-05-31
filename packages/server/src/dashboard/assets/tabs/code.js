// code.js — Code tab client module (ES module, no build).
// Migrated verbatim (logic-preserving) from the legacy `renderCode` +
// `renderCodeSavings`. Reads only from ctx.data.codeNav + ctx.data.codeNavSavings.
// See ARCHITECTURE.md §3/§4. NOTE: real .js file, so unicode escapes are
// single-backslash (—) unlike the legacy template literal.

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

function renderCode(ctx) {
  var $ = ctx.$, fmt = ctx.fmt, esc = ctx.esc;
  var cn = ctx.data.codeNav || null;
  if (!cn) {
    $('codeRepoCount').textContent = '0';
    $('codeSymbolCount').textContent = '0';
    $('codeFileCount').textContent = '0';
    $('codeDbSize').textContent = '—';
    $('codeCallStats').textContent = 'no data';
    var tbEmpty = $('codeRepoTable');
    tbEmpty.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No repos registered. Use code_repo_register / code_repo_scan.</td></tr>';
  } else {
    $('codeRepoCount').textContent = fmt.fmt(cn.repoCount);
    $('codeSymbolCount').textContent = fmt.fmt(cn.symbolCount);
    $('codeFileCount').textContent = fmt.fmt(cn.fileCount);
    $('codeDbSize').textContent = fmt.fmtBytes(cn.dbSizeBytes);
    var resolved = (cn.callCount && cn.callCount.resolved) || 0;
    var unresolved = (cn.callCount && cn.callCount.unresolved) || 0;
    $('codeCallStats').textContent = fmt.fmt(resolved) + ' / ' + fmt.fmt(resolved + unresolved) + ' calls resolved';
    var rows = (cn.perRepo || []).map(function (r) {
      return '<tr>'
        + '<td>' + esc(r.slug) + '</td>'
        + '<td>' + fmt.fmt(r.symbols) + '</td>'
        + '<td>' + fmt.fmt(r.files) + '</td>'
        + '<td>' + (r.lastIndexedAt ? fmt.fmtAgo(r.lastIndexedAt) : '—') + '</td>'
        + '</tr>';
    });
    var tb = $('codeRepoTable');
    if (rows.length === 0) {
      tb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No repos registered.</td></tr>';
    } else {
      tb.innerHTML = rows.join('');
    }
  }
  renderCodeSavings(ctx);
}

function renderCodeSavings(ctx) {
  var $ = ctx.$, fmt = ctx.fmt, esc = ctx.esc;
  var sv = ctx.data.codeNavSavings || null;
  var summary = $('codeSavingsSummary');
  var tb = $('codeSavingsTable');
  var rb = $('codeSavingsRepoTable');
  var chart = $('codeSavingsChart');
  if (!sv || !sv.totalCalls) {
    summary.textContent = 'No code-nav tool calls recorded yet.';
    tb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No data yet — call code_symbol_search / code_file_outline / etc. to populate.</td></tr>';
    if (rb) rb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No per-repo data yet.</td></tr>';
    chart.textContent = '';
    return;
  }
  // $0.003/1k tokens — Claude Sonnet input pricing (rough baseline).
  var costUsd = (sv.totalSaved / 1000) * 0.003;
  summary.innerHTML = 'Total tokens saved: <strong>' + fmt.fmt(sv.totalSaved)
    + '</strong> across <strong>' + fmt.fmt(sv.totalCalls) + '</strong> calls '
    + '(≈ $' + costUsd.toFixed(2) + ' at Claude Sonnet input pricing — approximate).';
  var byTool = sv.savedByTool || {};
  var names = Object.keys(byTool).sort(function (a, b) {
    return byTool[b].tokensSaved - byTool[a].tokensSaved;
  });
  var rows = names.map(function (name) {
    var t = byTool[name];
    return '<tr>'
      + '<td>' + esc(name) + '</td>'
      + '<td>' + fmt.fmt(t.calls) + '</td>'
      + '<td>' + fmt.fmt(t.tokensSaved) + '</td>'
      + '<td>' + fmt.fmt(t.avgSaved) + '</td>'
      + '</tr>';
  });
  tb.innerHTML = rows.join('');

  // Per-repo savings table (best-effort attribution).
  if (rb) {
    var byRepo = sv.savedByRepo || {};
    var repos = Object.keys(byRepo).sort(function (a, b) {
      return byRepo[b].tokensSaved - byRepo[a].tokensSaved;
    });
    if (repos.length === 0) {
      rb.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No per-repo data yet — multi-repo or unattributed calls only.</td></tr>';
    } else {
      var rrows = repos.map(function (slug) {
        var r = byRepo[slug];
        return '<tr>'
          + '<td>' + esc(slug) + '</td>'
          + '<td>' + fmt.fmt(r.calls) + '</td>'
          + '<td>' + fmt.fmt(r.tokensSaved) + '</td>'
          + '<td>' + fmt.fmt(r.avgSaved) + '</td>'
          + '</tr>';
      });
      rb.innerHTML = rrows.join('');
    }
  }

  // Render a tiny ASCII bar chart of cumulativeSaved over the last samples.
  var hist = sv.history || [];
  if (hist.length < 2) {
    chart.textContent = '';
  } else {
    var maxVal = hist[hist.length - 1].cumulativeSaved || 1;
    var step = Math.max(1, Math.floor(hist.length / 30));
    var blocks = '';
    var bars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    for (var i = 0; i < hist.length; i += step) {
      var frac = hist[i].cumulativeSaved / maxVal;
      var idx = Math.max(0, Math.min(7, Math.floor(frac * 8)));
      blocks += bars[idx];
    }
    chart.textContent = 'Cumulative savings trend: ' + blocks;
  }
}
