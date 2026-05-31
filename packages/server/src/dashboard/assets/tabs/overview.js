// overview.js — Overview tab client module (ES module, no build).
// REFERENCE IMPLEMENTATION the other tabs copy. Migrated verbatim from the
// legacy `renderOverview` + `renderToolTable` + sort state/header wiring.
// Reads only from ctx.data. See ARCHITECTURE.md §3/§4.

/** @typedef {import('../core.js').Ctx} Ctx */

// Tool-table sort state belongs to this tab (not the core).
var sortCol = 'last';
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
        el.querySelectorAll('th[data-col] .sort-arrow').forEach(function (a) { a.textContent = ''; });
        th.querySelector('.sort-arrow').textContent = sortDir > 0 ? '▲' : '▼';
        var d = ctx.data;
        if (d.toolCalls) renderToolTable(el, ctx, d.toolCalls);
      });
      // Set initial sort arrow
      if (th.getAttribute('data-col') === sortCol) {
        th.querySelector('.sort-arrow').textContent = sortDir > 0 ? '▲' : '▼';
      }
    });
  },

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    var fmt = ctx.fmt;
    var $ = ctx.$;
    var d2 = ctx.data;

    var rbc = d2.requestsByCategory || { health: 0, mcp: 0, oauth: 0, dashboard: 0, other: 0 };
    $('mcpRequests').textContent = fmt.fmt(rbc.mcp);
    $('rpm').textContent = fmt.fmt(d2.requestsPerMinute);
    $('activeSessions').textContent = fmt.fmt(d2.activeSessionsCount);
    $('indexedNotes').textContent = fmt.fmt(d2.indexedNotes);
    $('uptime').textContent = fmt.fmtUptime(d2.uptime);

    // Request breakdown secondary line
    var parts = [];
    if (rbc.oauth) parts.push('oauth ' + fmt.fmt(rbc.oauth));
    if (rbc.dashboard) parts.push('dash ' + fmt.fmt(rbc.dashboard));
    if (rbc.health) parts.push('health ' + fmt.fmt(rbc.health));
    if (rbc.other) parts.push('other ' + fmt.fmt(rbc.other));
    $('requestBreakdown').textContent = parts.length ? parts.join(' · ') : '';

    // Error responses
    var errCount = d2.errorResponses || 0;
    var errEl = $('errorRate');
    errEl.textContent = fmt.fmt(errCount);
    errEl.style.color = errCount > 0 ? 'var(--red)' : 'var(--green)';
    var totalNonHealth = d2.totalRequests - (rbc.health || 0);
    var errPctVal = totalNonHealth > 0 ? ((errCount / totalNonHealth) * 100).toFixed(1) : '0';
    $('errorPct').textContent = errPctVal + '% of non-health requests';

    // Charts from latencyHistory
    var lh = d2.latencyHistory || [];
    var rpmPts = lh.map(function (e) { return { y: e.requestCount }; });
    var latPts = lh.map(function (e) { return { y: e.avgLatencyMs }; });
    ctx.charts.drawChart('chartRpm', rpmPts, '#58a6ff');
    ctx.charts.drawChart('chartLatency', latPts, '#3fb950');

    // Log level counts from system logs
    var sysLogs = d2.systemLogs || [];
    var errC = 0, warnC = 0, infoC = 0;
    for (var li = 0; li < sysLogs.length; li++) {
      if (sysLogs[li].level === 'error') errC++;
      else if (sysLogs[li].level === 'warn') warnC++;
      else if (sysLogs[li].level === 'info') infoC++;
    }
    $('logErrorCount').textContent = fmt.fmt(errC);
    $('logWarnCount').textContent = fmt.fmt(warnC);
    $('logInfoCount').textContent = fmt.fmt(infoC);

    // Embedding status in overview
    var embSt = d2.embeddingStats || {};
    var ovEmb = $('ovEmbStatus');
    if (embSt.ready) {
      ovEmb.textContent = 'Active (' + fmt.fmt(embSt.indexSize) + ')';
      ovEmb.style.color = 'var(--green)';
    } else {
      ovEmb.textContent = 'Disabled';
      ovEmb.style.color = 'var(--red)';
    }

    // Tool table
    renderToolTable(el, ctx, d2.toolCalls || {});
  },
};

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
      case 'errors': va = a[1].errors; vb = b[1].errors; break;
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
  tbody.innerHTML = entries.map(function (e) {
    var name = e[0], m = e[1];
    return '<tr>'
      + '<td>' + esc(name) + '</td>'
      + '<td>' + fmt.fmt(m.count) + '</td>'
      + '<td class="' + fmt.latClass(m.avgLatency) + '">' + fmt.fmtMs(m.avgLatency) + '</td>'
      + '<td class="' + fmt.latClass(m.p95Latency) + '">' + fmt.fmtMs(m.p95Latency) + '</td>'
      + '<td class="' + fmt.latClass(m.maxLatency) + '">' + fmt.fmtMs(m.maxLatency) + '</td>'
      + '<td' + (m.errors > 0 ? ' class="err-red"' : '') + '>' + m.errors + '</td>'
      + '<td>' + fmt.fmtAgo(m.lastCalled) + '</td>'
      + '</tr>';
  }).join('');
}
