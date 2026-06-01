// overview.js — Overview tab client module (ES module, no build).
// FLAGSHIP REFERENCE the other tabs copy. Reads only from ctx.data (incl.
// ctx.data.derived from model/derive.ts). Fills Bands A–D of the rebuilt
// Overview (REVAMP.md §5 TAB 1). Preserves the legacy tool-table sort + all
// legacy element ids. See ARCHITECTURE.md §3/§4.

/** @typedef {import('../core.js').Ctx} Ctx */

// Tool-table sort state belongs to this tab (not the core).
var sortCol = 'count';
var sortDir = -1;

export default {
  id: 'overview',

  /** One-time: wire sortable table headers. */
  init(el, ctx) {
    el.querySelectorAll('th[data-col]').forEach(function (th) {
      th.addEventListener('click', function () {
        var col = th.getAttribute('data-col');
        if (sortCol === col) sortDir *= -1;
        else { sortCol = col; sortDir = -1; }
        el.querySelectorAll('th[data-col]').forEach(function (h) {
          h.removeAttribute('aria-sort');
          var a = h.querySelector('.sort-arrow'); if (a) a.textContent = '';
        });
        th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
        var arrow = th.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = sortDir > 0 ? '▲' : '▼';
        var d = ctx.data;
        if (d.toolCalls) renderToolTable(el, ctx, d.toolCalls);
      });
      // Set initial sort arrow on the default column.
      if (th.getAttribute('data-col') === sortCol) {
        th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
        var a0 = th.querySelector('.sort-arrow');
        if (a0) a0.textContent = sortDir > 0 ? '▲' : '▼';
      }
    });
  },

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    var fmt = ctx.fmt, $ = ctx.$, d = ctx.data;
    var dv = d.derived || {};

    renderStatusStrip(ctx, d);
    renderKpis(ctx, d, dv);
    renderAttention(el, ctx, d, dv);
    renderDetail(el, ctx, d, dv);

    // Tool table (Band D).
    renderToolTable(el, ctx, d.toolCalls || {});
    void fmt; void $;
  },
};

// ── Band A — System Status strip ─────────────────────────────────────────────

function setPill(ctx, id, state, label) {
  var pill = ctx.$(id);
  if (!pill) return;
  pill.className = 'pill pill--' + state;
  // Replace the trailing text node while keeping the leading dot span.
  var dot = pill.querySelector('.dot');
  pill.textContent = '';
  if (dot) pill.appendChild(dot);
  pill.appendChild(document.createTextNode(label));
}

function renderStatusStrip(ctx, d) {
  // MCP / SSE — driven by body[data-sse] (reconnecting) else online.
  var reconnecting = document.body.getAttribute('data-sse') === 'reconnecting';
  setPill(ctx, 'stMcp', reconnecting ? 'warn' : 'ok', reconnecting ? 'MCP reconnecting' : 'MCP / SSE online');

  // Local LLM — configured + available.
  var llm = d.llmStatus || {};
  if (!llm.configured) setPill(ctx, 'stLlm', 'muted', 'Local LLM off');
  else if (llm.available) setPill(ctx, 'stLlm', 'ok', 'Local LLM up');
  else setPill(ctx, 'stLlm', 'bad', 'Local LLM down');

  // Embeddings — ready/loading.
  var emb = d.embeddingStats || {};
  setPill(ctx, 'stEmb', emb.ready ? 'ok' : 'warn', emb.ready ? 'Embeddings ready' : 'Embeddings loading');

  // Search index — clean/errors.
  var ih = d.indexHealth || {};
  var idxErrors = (ih.errors && ih.errors.length) || ih.errorCount || 0;
  setPill(ctx, 'stIndex', idxErrors > 0 ? 'bad' : 'ok', idxErrors > 0 ? ('Index ' + idxErrors + ' errors') : 'Index clean');

  // Vault health — grade band.
  var hs = d.healthScore || {};
  var grade = hs.grade || '—';
  var g = String(grade).charAt(0).toUpperCase();
  var vState = g === 'A' || g === 'B' ? 'ok' : g === 'C' || g === 'D' ? 'warn' : g === 'F' ? 'bad' : 'muted';
  setPill(ctx, 'stVault', vState, 'Vault ' + grade);
}

// ── Band B — KPI scorecards ──────────────────────────────────────────────────

function gradeClassOf(grade) {
  var g = String(grade || '').charAt(0).toUpperCase();
  if (g === 'A' || g === 'B') return 'ok';
  if (g === 'C' || g === 'D') return 'warn';
  if (g === 'F') return 'bad';
  return 'muted';
}

function pillHtml(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}

function deltaHtml(tr, invert) {
  if (!tr) return '';
  var dir = tr.dir || 'flat';
  var glyph = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  var pct = Math.abs(tr.pct || 0);
  return '<span class="kpi-delta ' + dir + (invert ? ' invert' : '') + '">' +
    '<span aria-hidden="true">' + glyph + '</span>' + pct + '%</span>';
}

function renderKpis(ctx, d, dv) {
  var fmt = ctx.fmt, $ = ctx.$, setLive = ctx.setLive;
  var rbc = d.requestsByCategory || { health: 0, mcp: 0, oauth: 0, dashboard: 0, other: 0 };

  // 1. MCP Requests
  setLive('mcpRequests', fmt.fmt(rbc.mcp));
  var parts = [];
  parts.push((d.requestsPerMinute || 0) + ' req/min');
  if (rbc.oauth) parts.push('oauth ' + fmt.fmt(rbc.oauth));
  if (rbc.dashboard) parts.push('dash ' + fmt.fmt(rbc.dashboard));
  if (rbc.other) parts.push('other ' + fmt.fmt(rbc.other));
  if ($('requestBreakdown')) $('requestBreakdown').textContent = parts.join(' · ');
  if ($('mcpDelta')) $('mcpDelta').innerHTML = deltaHtml(dv.rpmTrend, false);
  ctx.charts.drawChart('kpiRpmSpark', (dv.rpmSeries || []).map(function (y) { return { y: y }; }), 'var(--brand)');

  // 2. Error Rate %
  var erp = dv.errorRatePct != null ? dv.errorRatePct : 0;
  setLive('errorRate', erp + '%');
  if ($('errorPct')) $('errorPct').textContent = fmt.fmt(d.errorResponses || 0) + ' errors / non-health reqs';
  if ($('errorPill')) $('errorPill').innerHTML = pillHtml(stateFor(erp, 'errorRatePct'), erp < 1 ? 'healthy' : erp <= 5 ? 'elevated' : 'high');

  // 3. Latency Health
  var lh = d.latencyHistory || [];
  var lastLat = lh.length ? lh[lh.length - 1].avgLatencyMs : 0;
  setLive('latencyVal', fmt.fmtMs(lastLat));
  var tail = dv.latencyTailRatio || 0;
  if ($('latencyTail')) $('latencyTail').textContent = 'p95÷avg ' + tail.toFixed(1) + 'x tail';
  if ($('latencyPill')) $('latencyPill').innerHTML = pillHtml(stateFor(tail, 'latencyTailRatio'), tail <= 2 ? 'tight' : tail <= 3 ? 'spread' : 'heavy tail');
  ctx.charts.drawChart('kpiLatSpark', lh.map(function (e) { return { y: e.avgLatencyMs }; }), 'var(--info)');

  // 4. Vault Health
  var hs = d.healthScore || {};
  setLive('vaultHealthVal', hs.grade != null ? String(hs.grade) : '—');
  if ($('vaultHealthSub')) $('vaultHealthSub').textContent = hs.score != null ? ('score ' + Math.round(hs.score)) : '';
  if ($('vaultHealthPill')) {
    var ht = dv.healthTrend;
    $('vaultHealthPill').innerHTML = pillHtml(gradeClassOf(hs.grade), 'grade') + (ht ? ' ' + deltaHtml(ht, false) : '');
  }
  ctx.charts.drawChart('kpiHealthSpark', (d.dreamHistory || []).map(function (x) { return { y: x.healthScore }; }), 'var(--brand-2)');

  // 5. Active Sessions
  var totalSessions = (d.sessions && d.sessions.length) || d.activeSessionsCount || 0;
  setLive('activeSessions', fmt.fmt(totalSessions));
  if ($('sessionsSub')) $('sessionsSub').textContent = (dv.activeSessions || 0) + ' active (last 60s)';

  // 6. Memory Temperature
  var mt = d.memoryTemperature || { hot: 0, warm: 0, cold: 0 };
  var tot = (mt.hot || 0) + (mt.warm || 0) + (mt.cold || 0);
  setLive('memTempVal', fmt.fmt(tot));
  if ($('memTempSub')) $('memTempSub').textContent = 'hot ' + fmt.fmt(mt.hot) + ' · warm ' + fmt.fmt(mt.warm) + ' · cold ' + fmt.fmt(mt.cold);
  renderTempBar(ctx, mt, tot);

  // 7. Code-Nav Savings
  var cns = d.codeNavSavings || {};
  setLive('savingsVal', fmt.fmt(cns.totalSaved || 0));
  var rate = dv.savingsRunRate || 0;
  if ($('savingsSub')) $('savingsSub').textContent = (dv.savingsPerCall || 0) + '/call · ~' + fmt.fmt(rate) + '/day';
  ctx.charts.drawChart('kpiSavingsSpark', (cns.history || []).map(function (h) { return { y: h.cumulativeSaved }; }), 'var(--brand)');

  // 8. Indexed Notes
  setLive('indexedNotes', fmt.fmt(d.indexedNotes || 0));
  var cov = dv.embeddingCoverage != null ? Math.round(dv.embeddingCoverage * 100) : 0;
  if ($('notesSub')) $('notesSub').textContent = cov + '% embedded';
}

function renderTempBar(ctx, mt, tot) {
  var bar = ctx.$('memTempBar');
  if (!bar) return;
  if (!tot) { bar.innerHTML = ''; return; }
  function seg(cls, n) {
    if (!n) return '';
    return '<div class="seg ' + cls + '" style="width:' + ((n / tot) * 100).toFixed(1) + '%"></div>';
  }
  bar.innerHTML = seg('seg-hot', mt.hot) + seg('seg-warm', mt.warm) + seg('seg-cold', mt.cold);
}

/** Threshold classification mirrored from model/derive THRESHOLDS (kept in sync). */
function stateFor(value, key) {
  var T = {
    errorRatePct: { good: 1, warn: 5, dir: 'lower' },
    latencyTailRatio: { good: 2, warn: 3, dir: 'lower' },
  }[key];
  if (!T) return 'ok';
  if (T.dir === 'lower') return value <= T.good ? 'ok' : value <= T.warn ? 'warn' : 'bad';
  return value >= T.good ? 'ok' : value >= T.warn ? 'warn' : 'bad';
}

// ── Band C — Attention feed ──────────────────────────────────────────────────

function renderAttention(el, ctx, d, dv) {
  var fmt = ctx.fmt, esc = ctx.esc;
  var errBox = ctx.$('attnErrors');
  if (errBox) {
    var items = [];
    (d.recentErrors || []).slice(-5).reverse().forEach(function (e) {
      items.push({ ts: e.timestamp, tool: e.tool || 'error', msg: e.message || '' });
    });
    (d.recentAuthFailures || []).slice(-3).reverse().forEach(function (a) {
      items.push({ ts: a.timestamp, tool: 'auth ' + (a.ip || ''), msg: a.reason || 'auth failure' });
    });
    if (!items.length) {
      errBox.innerHTML = emptyHtml('All clear', 'No recent errors or auth failures.');
    } else {
      errBox.innerHTML = items.slice(0, 6).map(function (it) {
        return '<div class="error-item"><span class="e-ts">' + esc(fmt.fmtTime(it.ts)) + '</span>'
          + '<span class="e-tool">' + esc(it.tool) + '</span>'
          + '<span class="e-msg">' + esc(ctx.fmt.truncate(it.msg, 120)) + '</span></div>';
      }).join('') + '<button type="button" class="btn btn--sm btn--ghost" onclick="window.cortex.switchTab(\'logs\')">View in Logs →</button>';
    }
  }

  var sig = ctx.$('attnSignals');
  if (sig) {
    var rows = [];
    var throttled = dv.throttledNow || 0;
    if (throttled > 0) rows.push(signalRow('warn', throttled + ' IP' + (throttled > 1 ? 's' : '') + ' throttled', 'ratelimits', 'Rate Limits'));
    var ld = d.lastDream || {};
    var recs = ((ld.connectionSuggestions || []).length) + ((ld.consolidationGroups || []).length);
    if (recs > 0) rows.push(signalRow('ok', recs + ' AI recommendation' + (recs > 1 ? 's' : ''), 'intelligence', 'Intelligence'));
    var orphans = (ld.orphans || []).length;
    if (orphans > 0) rows.push(signalRow('warn', orphans + ' orphan memor' + (orphans > 1 ? 'ies' : 'y'), 'intelligence', 'Intelligence'));
    if (!rows.length) rows.push(emptyHtml('Nothing pending', 'No recommendations or orphans.'));
    sig.innerHTML = rows.join('');
  }
}

function signalRow(state, label, tab, tabLabel) {
  return '<button type="button" class="pill pill--' + state + '" style="margin:.2rem .2rem .2rem 0"'
    + ' onclick="window.cortex.switchTab(\'' + tab + '\')" aria-label="' + label + ' — open ' + tabLabel + '">'
    + '<span class="dot" aria-hidden="true"></span>' + label + '</button>';
}

function emptyHtml(title, msg) {
  return '<div class="empty">'
    + '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/></svg>'
    + '<div class="empty-title">' + title + '</div>'
    + '<div class="empty-msg" style="padding:0">' + msg + '</div></div>';
}

// ── Band D — Operational detail ──────────────────────────────────────────────

function renderDetail(el, ctx, d, dv) {
  var lh = d.latencyHistory || [];
  ctx.charts.drawChart('chartRpm', lh.map(function (e) { return { y: e.requestCount }; }), 'var(--brand)');
  ctx.charts.drawChart('chartLatency', lh.map(function (e) { return { y: e.avgLatencyMs }; }), 'var(--info)');

  var sw = ctx.$('ovSoWhat');
  if (sw) {
    var rpm = d.requestsPerMinute || 0;
    var erp = dv.errorRatePct != null ? dv.errorRatePct : 0;
    var hs = d.healthScore || {};
    sw.innerHTML = '<b>' + rpm + '</b> req/min · error rate <b>' + erp + '%</b>'
      + (hs.grade ? ' · vault <b>' + ctx.esc(String(hs.grade)) + '</b>' : '')
      + ' · ' + (dv.activeSessions || 0) + ' active session' + ((dv.activeSessions || 0) === 1 ? '' : 's');
  }
}

function renderToolTable(el, ctx, tc) {
  var fmt = ctx.fmt, esc = ctx.esc;
  var entries = [];
  for (var k in tc) { if (Object.prototype.hasOwnProperty.call(tc, k)) entries.push([k, tc[k]]); }
  entries.sort(function (a, b) {
    var va, vb;
    switch (sortCol) {
      case 'name': return sortDir * a[0].localeCompare(b[0]);
      case 'count': va = a[1].count; vb = b[1].count; break;
      case 'avg': va = a[1].avgLatency; vb = b[1].avgLatency; break;
      case 'p95': va = a[1].p95Latency; vb = b[1].p95Latency; break;
      case 'max': va = a[1].maxLatency; vb = b[1].maxLatency; break;
      case 'errors': va = a[1].count ? a[1].errors / a[1].count : 0; vb = b[1].count ? b[1].errors / b[1].count : 0; break;
      case 'last': va = a[1].lastCalled || 0; vb = b[1].lastCalled || 0; break;
      default: va = a[1].count; vb = b[1].count;
    }
    return sortDir * ((va || 0) - (vb || 0));
  });
  var tbody = ctx.$('toolTableBody');
  if (!tbody) return;
  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-msg" style="text-align:center">No tool calls recorded</td></tr>';
    return;
  }
  // Max avg-latency across tools → relative bar width.
  var maxAvg = 1;
  entries.forEach(function (e) { if (e[1].avgLatency > maxAvg) maxAvg = e[1].avgLatency; });

  tbody.innerHTML = entries.map(function (e) {
    var name = e[0], m = e[1];
    var errRate = m.count ? (m.errors / m.count) * 100 : 0;
    var errState = errRate === 0 ? 'var(--ok)' : errRate <= 5 ? 'var(--warn)' : 'var(--err)';
    var barW = Math.max(2, (m.avgLatency / maxAvg) * 56);
    return '<tr>'
      + '<td>' + esc(name) + '</td>'
      + '<td class="num">' + fmt.fmt(m.count) + '</td>'
      + '<td class="num ' + fmt.latClass(m.avgLatency) + '">'
        + '<span class="cell-bar" style="width:' + barW.toFixed(0) + 'px"></span> ' + fmt.fmtMs(m.avgLatency) + '</td>'
      + '<td class="num ' + fmt.latClass(m.p95Latency) + '">' + fmt.fmtMs(m.p95Latency) + '</td>'
      + '<td class="num ' + fmt.latClass(m.maxLatency) + '">' + fmt.fmtMs(m.maxLatency) + '</td>'
      + '<td class="num"><span class="cell-dot" style="background:' + errState + '"></span>' + errRate.toFixed(errRate < 10 ? 1 : 0) + '%</td>'
      + '<td>' + fmt.fmtAgo(m.lastCalled) + '</td>'
      + '</tr>';
  }).join('');
}
