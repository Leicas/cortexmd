// logs.js — Logs tab client module (ES module, no build).
// Reads only from ctx.data (systemLogs / recentToolCalls / recentErrors /
// recentAuthFailures + ctx.data.derived). REVAMP.md §5 TAB 8: a summary strip of
// KPI tiles (errors/min, tool success rate, top error signature, auth fails/min)
// is filled on every SSE tick; the four feeds below it keep their original ids,
// filter controls, and behavior as drill-down. Filter listeners are wired once in
// init(); refresh() re-renders the strip + all four feeds from current state.
// See ARCHITECTURE.md §3/§4.

/** @typedef {import('../core.js').Ctx} Ctx */

// Threshold mirrored from model/derive THRESHOLDS (kept in sync). toolSuccessRate
// is higher-better; errors/min + auth/min use local lower-better cutoffs.
function successState(rate01) {
  if (rate01 >= 0.98) return 'ok';
  if (rate01 >= 0.9) return 'warn';
  return 'bad';
}
function perMinState(v) {
  if (v <= 1) return 'ok';
  if (v <= 5) return 'warn';
  return 'bad';
}

function pillHtml(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}

/** Bucket epoch-ms timestamps into per-minute counts over the last windowMin. */
function bucketPerMinute(timestamps, windowMin) {
  windowMin = windowMin || 15;
  var out = new Array(windowMin).fill(0);
  var now = Date.now();
  for (var i = 0; i < timestamps.length; i++) {
    var ts = timestamps[i];
    if (typeof ts === 'string') ts = Date.parse(ts);
    if (!isFinite(ts)) continue;
    var minsAgo = Math.floor((now - ts) / 60000);
    if (minsAgo < 0 || minsAgo >= windowMin) continue;
    out[windowMin - 1 - minsAgo]++;
  }
  return out;
}

/** Group error-ish events into recurring signatures → [{ key, count }] desc. */
function topErrorSignatures(errors, toolCalls) {
  var groups = {};
  function add(tool, message) {
    // Signature = tool + normalized message prefix (numbers/ids collapsed).
    var msg = String(message || '').toLowerCase()
      .replace(/[0-9a-f]{8,}/g, '#')   // ids/hashes
      .replace(/\d+/g, 'N')            // numbers
      .slice(0, 48).trim();
    var key = (tool ? tool + ': ' : '') + (msg || 'error');
    groups[key] = (groups[key] || 0) + 1;
  }
  (errors || []).forEach(function (e) { add(e.tool, e.message); });
  (toolCalls || []).forEach(function (c) { if (c.status === 'error') add(c.tool, c.detail || ''); });
  var list = [];
  for (var k in groups) { if (Object.prototype.hasOwnProperty.call(groups, k)) list.push({ key: k, count: groups[k] }); }
  list.sort(function (a, b) { return b.count - a.count; });
  return list;
}

export default {
  id: 'logs',

  /** One-time: wire the log filter controls to re-render on change/input. */
  init(el, ctx) {
    var self = this;
    var refresh = function () { self.refresh(el, ctx); };
    ['logFilterDebug', 'logFilterInfo', 'logFilterWarn', 'logFilterError'].forEach(function (id) {
      var node = ctx.$(id);
      if (node) node.addEventListener('change', refresh);
    });
    var src = ctx.$('logFilterSource');
    if (src) src.addEventListener('change', refresh);
    var textInput = ctx.$('logFilterText');
    if (textInput) {
      var textTimer = null;
      textInput.addEventListener('input', function () {
        clearTimeout(textTimer);
        textTimer = setTimeout(refresh, 200);
      });
    }
  },

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    var d = ctx.data;
    var dv = d.derived || {};
    renderStrip(ctx, d, dv);
    renderSystemLogs(ctx, d);
    renderToolCalls(ctx, d);
    renderErrors(ctx, d);
    renderAuthFailures(ctx, d);
  },
};

// ── Band A — summary strip ────────────────────────────────────────────────────

function renderStrip(ctx, d, dv) {
  var fmt = ctx.fmt, $ = ctx.$, setLive = ctx.setLive, charts = ctx.charts;
  var logs = d.systemLogs || [];
  var errors = d.recentErrors || [];
  var calls = d.recentToolCalls || [];

  // 1. Errors / min — recentErrors + error-level systemLogs, bucketed per minute.
  var errTs = errors.map(function (e) { return e.timestamp; });
  logs.forEach(function (l) { if (l.level === 'error') errTs.push(l.timestamp); });
  var errBuckets = bucketPerMinute(errTs, 15);
  var lastErrMin = errBuckets.length ? errBuckets[errBuckets.length - 1] : 0;
  var errWindowTotal = errBuckets.reduce(function (a, b) { return a + b; }, 0);
  setLive('logErrPerMin', String(lastErrMin));
  if ($('logErrPerMinSub')) $('logErrPerMinSub').textContent = errWindowTotal + ' in 15 min';
  if ($('logErrPill')) $('logErrPill').innerHTML = pillHtml(perMinState(lastErrMin), lastErrMin === 0 ? 'quiet' : lastErrMin <= 5 ? 'elevated' : 'spiking');
  charts.drawBars('logErrSpark', errBuckets, 'var(--err)');

  // 2. Tool success rate — rolling ok/error over recentToolCalls.
  var okCount = 0, errCount = 0;
  calls.forEach(function (c) { if (c.status === 'error') errCount++; else okCount++; });
  var total = okCount + errCount;
  var rate = total ? okCount / total : 1;
  setLive('logSuccessRate', total ? (Math.round(rate * 1000) / 10) + '%' : '—');
  if ($('logSuccessSub')) $('logSuccessSub').textContent = total ? (okCount + ' ok · ' + errCount + ' err / ' + total + ' calls') : 'no calls recorded';
  if ($('logSuccessPill')) $('logSuccessPill').innerHTML = total
    ? pillHtml(successState(rate), errCount === 0 ? 'all passing' : errCount <= total * 0.1 ? 'some errors' : 'failing')
    : pillHtml('muted', 'idle');

  // 3. Top error signature — recurring problem, not 50 lines.
  var sigs = topErrorSignatures(errors, calls);
  if (sigs.length) {
    var top = sigs[0];
    setLive('logTopErr', '×' + top.count);
    if ($('logTopErr')) $('logTopErr').setAttribute('title', top.key);
    if ($('logTopErrSub')) $('logTopErrSub').textContent = fmt.truncate(top.key, 38)
      + (sigs.length > 1 ? '  (+' + (sigs.length - 1) + ' more)' : '');
  } else {
    setLive('logTopErr', 'none');
    if ($('logTopErr')) $('logTopErr').removeAttribute('title');
    if ($('logTopErrSub')) $('logTopErrSub').textContent = 'no recurring errors';
  }

  // 4. Auth failures / min — reuse derived.authFailPerMin (shared w/ Rate Limits).
  var authBuckets = (dv.authFailPerMin && dv.authFailPerMin.length)
    ? dv.authFailPerMin
    : bucketPerMinute((d.recentAuthFailures || []).map(function (a) { return a.timestamp; }), 15);
  var lastAuthMin = authBuckets.length ? authBuckets[authBuckets.length - 1] : 0;
  var authWindowTotal = authBuckets.reduce(function (a, b) { return a + b; }, 0);
  setLive('logAuthPerMin', String(lastAuthMin));
  if ($('logAuthSub')) $('logAuthSub').textContent = authWindowTotal + ' in 15 min';
  if ($('logAuthPill')) $('logAuthPill').innerHTML = pillHtml(perMinState(lastAuthMin), lastAuthMin === 0 ? 'no attempts' : lastAuthMin <= 5 ? 'watch' : 'attack?');
  charts.drawBars('logAuthSpark', authBuckets, 'var(--warn)');

  // So-what strip.
  var sw = $('logsSoWhat');
  if (sw) {
    var parts = [];
    parts.push('Errors <b>' + lastErrMin + '/min</b>' + (errWindowTotal ? ' (' + errWindowTotal + '/15m)' : ''));
    if (total) parts.push('tool success <b>' + (Math.round(rate * 1000) / 10) + '%</b>');
    if (sigs.length) parts.push('top issue <b>' + ctx.esc(fmt.truncate(sigs[0].key, 36)) + '</b> ×' + sigs[0].count);
    if (authWindowTotal) parts.push('<b>' + authWindowTotal + '</b> auth failure' + (authWindowTotal === 1 ? '' : 's') + '/15m');
    sw.innerHTML = parts.join(' · ');
  }
}

// ── Band B — system logs feed (filtered) ──────────────────────────────────────

function renderSystemLogs(ctx, d) {
  var fmt = ctx.fmt, esc = ctx.esc, escAttr = ctx.escAttr, $ = ctx.$;
  var logs = d.systemLogs || [];
  var showDebug = $('logFilterDebug') ? $('logFilterDebug').checked : false;
  var showInfo = $('logFilterInfo') ? $('logFilterInfo').checked : true;
  var showWarn = $('logFilterWarn') ? $('logFilterWarn').checked : true;
  var showError = $('logFilterError') ? $('logFilterError').checked : true;
  var sourceFilter = $('logFilterSource') ? $('logFilterSource').value : 'all';
  var textFilter = (($('logFilterText') && $('logFilterText').value) || '').toLowerCase();

  var filtered = logs.filter(function (l) {
    if (l.level === 'debug' && !showDebug) return false;
    if (l.level === 'info' && !showInfo) return false;
    if (l.level === 'warn' && !showWarn) return false;
    if (l.level === 'error' && !showError) return false;
    if (sourceFilter !== 'all' && (l.source || 'general') !== sourceFilter) return false;
    if (textFilter && l.message.toLowerCase().indexOf(textFilter) === -1) return false;
    return true;
  });

  var slEl = $('systemLogsFeed');
  if (!slEl) return;
  if (!filtered.length) {
    slEl.innerHTML = '<div class="empty-msg">No logs matching filters (' + logs.length + ' total).</div>';
    return;
  }
  slEl.innerHTML = filtered.map(function (l) {
    var metaStr = l.meta ? JSON.stringify(l.meta) : '';
    var ts = l.timestamp ? new Date(l.timestamp).toISOString() : '';
    var fullLine = ts + ' [' + (l.source || 'general') + '] ' + l.level.toUpperCase() + ' ' + l.message + (metaStr ? ' ' + metaStr : '');
    return '<div class="log-entry" data-full="' + escAttr(fullLine) + '" onclick="cortex.copyLogLine(this)" style="cursor:pointer" title="Click to copy">'
      + '<span class="log-ts">' + fmt.fmtTime(l.timestamp) + '</span>'
      + '<span class="log-level l-' + l.level + '">' + l.level + '</span>'
      + '<span class="log-src">' + esc(l.source || 'general') + '</span>'
      + '<span class="log-msg">' + esc(l.message) + '</span>'
      + (metaStr ? '<span class="log-meta" title="' + escAttr(metaStr) + '">' + esc(metaStr) + '</span>' : '')
      + '</div>';
  }).join('');
  slEl.scrollTop = slEl.scrollHeight;
}

// ── Band C — tool calls + errors ──────────────────────────────────────────────

function renderToolCalls(ctx, d) {
  var fmt = ctx.fmt, esc = ctx.esc, escAttr = ctx.escAttr, $ = ctx.$;
  var calls = d.recentToolCalls || [];
  var callsEl = $('logToolCalls');
  if (!callsEl) return;
  if (!calls.length) {
    callsEl.innerHTML = '<div class="empty-msg">No tool calls recorded.</div>';
    return;
  }
  callsEl.innerHTML = calls.slice().reverse().map(function (c) {
    return '<div class="feed-item" style="flex-wrap:wrap">'
      + '<span class="feed-ts">' + fmt.fmtTime(c.timestamp) + '</span>'
      + '<span class="feed-tool">' + esc(c.tool) + '</span>'
      + '<span class="feed-status ' + (c.status === 'ok' ? 'ok' : 'error') + '">' + (c.status === 'ok' ? '✓' : '✗') + '</span>'
      + '<span class="feed-dur">' + fmt.fmtMs(c.durationMs) + '</span>'
      + (c.detail ? '<span style="width:100%;font-size:.72rem;color:var(--text-dim);margin-top:.15rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(c.detail) + '">' + esc(c.detail) + '</span>' : '')
      + '</div>';
  }).join('');
}

function renderErrors(ctx, d) {
  var fmt = ctx.fmt, esc = ctx.esc, $ = ctx.$;
  var errors = d.recentErrors || [];
  var countBadge = $('logErrCount');
  if (countBadge) {
    if (errors.length) { countBadge.textContent = errors.length; countBadge.style.display = ''; }
    else countBadge.style.display = 'none';
  }
  var errEl = $('logErrors');
  if (!errEl) return;
  if (!errors.length) {
    errEl.innerHTML = '<div class="empty-msg">No errors recorded.</div>';
    return;
  }
  errEl.innerHTML = errors.slice().reverse().map(function (e) {
    return '<div class="error-item">'
      + '<span class="e-ts">' + fmt.fmtTime(e.timestamp) + '</span>'
      + '<span class="e-tool">' + esc(e.tool) + '</span>'
      + '<span class="e-msg">' + esc(e.message) + '</span>'
      + '</div>';
  }).join('');
}

// ── Band D — auth failures table ──────────────────────────────────────────────

function renderAuthFailures(ctx, d) {
  var fmt = ctx.fmt, esc = ctx.esc, $ = ctx.$;
  var authFails = d.recentAuthFailures || [];
  var countBadge = $('logAuthCount');
  if (countBadge) {
    if (authFails.length) { countBadge.textContent = authFails.length; countBadge.style.display = ''; }
    else countBadge.style.display = 'none';
  }
  var afBody = $('authFailuresTableBody');
  if (!afBody) return;
  if (!authFails.length) {
    afBody.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No auth failures recorded.</td></tr>';
    return;
  }
  afBody.innerHTML = authFails.slice().reverse().map(function (f) {
    return '<tr>'
      + '<td>' + fmt.fmtTime(f.timestamp) + '</td>'
      + '<td class="mono">' + esc(f.ip) + '</td>'
      + '<td>' + esc(f.method) + '</td>'
      + '<td class="mono">' + esc(f.path) + '</td>'
      + '</tr>';
  }).join('');
}
