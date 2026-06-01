// ratelimits.js — Rate Limits tab client module (ES module, no build).
// REVAMP.md §5 TAB 3: framed as SECURITY (auth-failure throttling, not capacity).
// Fills the header KPI strip (throttled now · suspicious IPs · auth-fail rate)
// and the live tracking table with a countdown bar to `resetAt` + per-IP health.
// Reads only from ctx.data (incl. ctx.data.derived from model/derive.ts).
// Preserves the legacy id #rateLimitTableBody + the cortex.resetRl action.
// See ARCHITECTURE.md §3/§4 + overview.js (the reference module).

/** @typedef {import('../core.js').Ctx} Ctx */

// Sort state belongs to this tab (mirrors overview.js). Default: most failures first.
var sortCol = 'count';
var sortDir = -1;

export default {
  id: 'ratelimits',

  /** One-time: per-row reset action + sortable table headers. */
  init(el, ctx) {
    window.cortex = window.cortex || {};
    // Legacy `resetRateLimitAction(key)` — server-rendered rows call it.
    window.cortex.resetRl = function (key) {
      ctx.postAction('/dashboard/api/rate-limit/reset', { key: key });
    };

    el.querySelectorAll('th[data-col]').forEach(function (th) {
      th.addEventListener('click', function () {
        var col = th.getAttribute('data-col');
        if (sortCol === col) sortDir *= -1;
        else { sortCol = col; sortDir = col === 'ip' ? 1 : -1; }
        el.querySelectorAll('th[data-col]').forEach(function (h) {
          h.removeAttribute('aria-sort');
          var a = h.querySelector('.sort-arrow'); if (a) a.textContent = '';
        });
        th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
        var arrow = th.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = sortDir > 0 ? '▲' : '▼';
        renderTable(el, ctx);
      });
      if (th.getAttribute('data-col') === sortCol) {
        th.setAttribute('aria-sort', sortDir > 0 ? 'ascending' : 'descending');
        var a0 = th.querySelector('.sort-arrow');
        if (a0) a0.textContent = sortDir > 0 ? '▲' : '▼';
      }
    });
  },

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    renderKpis(ctx);
    renderTable(el, ctx);
    renderSoWhat(ctx);
  },
};

// ── helpers ───────────────────────────────────────────────────────────────────

/** Strip the `auth:` snapshot prefix to a bare IP. */
function ipOf(key) { return String(key || '').replace(/^auth:/, ''); }

/** Set of IPs that have recent auth failures (for the suspicious-IP join). */
function failingIpSet(d) {
  var set = Object.create(null);
  (d.recentAuthFailures || []).forEach(function (a) { if (a && a.ip) set[a.ip] = (set[a.ip] || 0) + 1; });
  return set;
}

function pillHtml(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}

// ── Header KPI strip ────────────────────────────────────────────────────────

function renderKpis(ctx) {
  var fmt = ctx.fmt, $ = ctx.$, setLive = ctx.setLive, d = ctx.data;
  var dv = d.derived || {};
  var limits = d.rateLimits || [];
  var failing = failingIpSet(d);

  // 1. IPs throttled now — the alarm (remaining === 0).
  var throttled = dv.throttledNow != null
    ? dv.throttledNow
    : limits.filter(function (r) { return r.remaining === 0; }).length;
  setLive('rlThrottled', fmt.fmt(throttled));
  if ($('rlThrottledSub')) $('rlThrottledSub').textContent = limits.length
    ? throttled + ' of ' + fmt.fmt(limits.length) + ' tracked at limit'
    : 'no IPs tracked';
  if ($('rlThrottledPill')) {
    $('rlThrottledPill').innerHTML = throttled === 0
      ? pillHtml('ok', 'clear')
      : pillHtml(throttled > 2 ? 'bad' : 'warn', throttled + ' at limit');
  }

  // 2. Suspicious IPs — throttle keys that ALSO appear in recent auth failures.
  var suspicious = 0;
  var worstIp = '', worstFails = 0;
  limits.forEach(function (r) {
    var ip = ipOf(r.key);
    var fails = failing[ip] || 0;
    if (fails > 0) suspicious++;
    if (fails > worstFails) { worstFails = fails; worstIp = ip; }
  });
  setLive('rlSuspicious', fmt.fmt(suspicious));
  if ($('rlSuspiciousSub')) {
    $('rlSuspiciousSub').textContent = worstFails > 0
      ? worstIp + ' · ' + worstFails + ' fail' + (worstFails > 1 ? 's' : '')
      : 'no overlap with auth failures';
  }
  if ($('rlSuspiciousPill')) {
    $('rlSuspiciousPill').innerHTML = suspicious === 0
      ? pillHtml('ok', 'none')
      : pillHtml(worstFails >= 10 ? 'bad' : 'warn', worstFails >= 10 ? 'likely attack' : 'watch');
  }

  // 3. Auth failures / min — sparkline over the shared per-minute buckets.
  var buckets = dv.authFailPerMin || [];
  var totalFails = (d.recentAuthFailures || []).length;
  var lastMin = buckets.length ? buckets[buckets.length - 1] : 0;
  setLive('rlAuthRate', fmt.fmt(lastMin));
  if ($('rlAuthSub')) {
    $('rlAuthSub').textContent = totalFails
      ? fmt.fmt(totalFails) + ' total · ' + lastMin + '/min now'
      : 'no recent failures';
  }
  // Color: brand when quiet, escalate to err on a spike.
  var spikeColor = lastMin >= 10 ? 'var(--err)' : lastMin > 0 ? 'var(--warn)' : 'var(--brand)';
  ctx.charts.drawBars('rlAuthSpark', buckets, spikeColor, { median: false });
}

// ── Live tracking table ─────────────────────────────────────────────────────

function renderTable(el, ctx) {
  var fmt = ctx.fmt, esc = ctx.esc, d = ctx.data;
  var limits = (d.rateLimits || []).slice();
  var failing = failingIpSet(d);
  var tbody = ctx.$('rateLimitTableBody');
  if (!tbody) return;

  if (!limits.length) {
    tbody.innerHTML = '<tr><td colspan="6">'
      + '<div class="empty">'
      + '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">'
      + '<path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>'
      + '<div class="empty-title">No IPs being tracked</div>'
      + '<div class="empty-msg" style="padding:0">Auth-failure throttling is idle — no client is at or near its limit.</div>'
      + '</div></td></tr>';
    return;
  }

  var now = Date.now();
  limits.sort(function (a, b) {
    var va, vb;
    switch (sortCol) {
      case 'ip': return sortDir * ipOf(a.key).localeCompare(ipOf(b.key));
      case 'remaining': va = a.remaining; vb = b.remaining; break;
      case 'count': default: va = a.count; vb = b.count; break;
    }
    return sortDir * ((va || 0) - (vb || 0));
  });

  tbody.innerHTML = limits.map(function (r) {
    var ip = ipOf(r.key);
    var fails = failing[ip] || 0;
    var throttled = r.remaining === 0;
    var suspicious = fails > 0;

    // Per-IP health: throttled = bad; failing-but-not-yet = warn; otherwise ok.
    var state = throttled ? 'bad' : suspicious ? 'warn' : 'ok';
    var statusLabel = throttled ? 'Throttled' : suspicious ? 'Watching' : 'Allowed';
    var statusCell = '<span class="badge badge--' + (state === 'bad' ? 'err' : state === 'warn' ? 'warn' : 'ok') + '">'
      + '<span class="dot" aria-hidden="true"></span>' + statusLabel
      + (suspicious ? ' · ' + fails + 'f' : '') + '</span>';

    // Countdown bar to resetAt (proportion of the 60s window remaining).
    var msLeft = Math.max(0, (r.resetAt || 0) - now);
    var pct = Math.max(0, Math.min(100, (msLeft / 60000) * 100));
    var barColor = throttled ? 'var(--err)' : suspicious ? 'var(--warn)' : 'var(--brand)';
    var secsLeft = Math.ceil(msLeft / 1000);
    var resetCell = '<div style="display:flex;align-items:center;gap:.5rem">'
      + '<span style="flex:1;height:6px;border-radius:var(--r-pill);background:var(--bg-elev);box-shadow:var(--inset-well);overflow:hidden;min-width:48px">'
      + '<span style="display:block;height:100%;width:' + pct.toFixed(0) + '%;background:' + barColor + ';opacity:.85;border-radius:var(--r-pill)"></span>'
      + '</span>'
      + '<span class="mono" style="color:var(--text-dim);font-size:var(--fs-xs);white-space:nowrap">'
      + (msLeft > 0 ? secsLeft + 's' : 'now') + '</span></div>';

    // "Remaining" — at-limit gets the error tint, others muted.
    var remClass = throttled ? 'err-red' : '';

    return '<tr>'
      + '<td class="mono">' + esc(ip) + '</td>'
      + '<td>' + statusCell + '</td>'
      + '<td class="num">' + fmt.fmt(r.count) + '</td>'
      + '<td class="num ' + remClass + '">' + fmt.fmt(r.remaining) + '</td>'
      + '<td>' + resetCell + '</td>'
      + '<td class="num"><button type="button" class="btn btn-danger btn--sm" '
        + 'onclick="cortex.resetRl(\'' + esc(r.key) + '\')" aria-label="Reset rate limit for ' + esc(ip) + '">Reset</button></td>'
      + '</tr>';
  }).join('');
}

// ── "So what?" strip ────────────────────────────────────────────────────────

function renderSoWhat(ctx) {
  var d = ctx.data, dv = d.derived || {};
  var sw = ctx.$('rlSoWhat');
  if (!sw) return;
  var limits = d.rateLimits || [];
  var failing = failingIpSet(d);
  var throttled = dv.throttledNow != null
    ? dv.throttledNow
    : limits.filter(function (r) { return r.remaining === 0; }).length;

  var worstIp = '', worstFails = 0;
  limits.forEach(function (r) {
    var f = failing[ipOf(r.key)] || 0;
    if (f > worstFails) { worstFails = f; worstIp = ipOf(r.key); }
  });

  if (!limits.length) {
    sw.innerHTML = '<span>No clients are being rate-limited — auth-failure throttling is idle.</span>';
    return;
  }
  var parts = [];
  parts.push('<b>' + throttled + '</b> IP' + (throttled === 1 ? '' : 's') + ' throttled');
  parts.push('<b>' + limits.length + '</b> tracked');
  if (worstFails > 0) {
    parts.push('worst: <b>' + ctx.esc(worstIp) + '</b> with <b>' + worstFails + '</b> auth failure'
      + (worstFails > 1 ? 's' : '') + (worstFails >= 10 ? ' (likely attack)' : ''));
  }
  sw.innerHTML = '<span>' + parts.join(' · ') + '</span>';
}
