// sessions.js — Sessions tab client module (ES module, no build).
// Revamped to the new design system (REVAMP.md §5 TAB 2). Reframes the raw
// session table as a fleet console: a 3-tile summary strip (active-vs-idle,
// request concentration, fleet tool mix) + a "so what" line above the detail
// table. Reads only from ctx.data (+ ctx.data.derived). Preserves the kill
// action and the #sessionsTableBody id / column contract. See ARCHITECTURE.md.

/** @typedef {import('../core.js').Ctx} Ctx */

// Active = activity within this many ms (mirrors derive.ts activeSessions).
var ACTIVE_MS = 60000;

// Stable palette for the fleet tool-mix stacked bar / legend (semantic +
// brand-neutral info hues; status colors stay reserved for health).
var MIX_COLORS = ['var(--brand)', 'var(--brand-2)', 'var(--info)', 'var(--warn)', 'var(--text-mute)'];

export default {
  id: 'sessions',

  /** One-time: register the kill action server-rendered rows reference. */
  init(el, ctx) {
    window.cortex = window.cortex || {};
    window.cortex.kill = function (sid) {
      if (!confirm('Kill session ' + sid.slice(0, 8) + '...?')) return;
      ctx.postAction('/dashboard/api/sessions/kill', { sessionId: sid });
    };
  },

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    var d = ctx.data;
    var sessions = d.sessions || [];
    var dv = d.derived || {};

    var stats = computeStats(sessions, dv);
    renderStrip(ctx, stats);
    renderSoWhat(ctx, stats);
    renderTable(ctx, sessions, stats);
  },
};

// ── aggregation ──────────────────────────────────────────────────────────────

/** Single pass over sessions → the numbers all three tiles + the table need. */
function computeStats(sessions, dv) {
  var now = Date.now();
  var active = 0, sumReq = 0, maxReq = 0;
  var fleet = {};            // toolName -> count across all sessions
  for (var i = 0; i < sessions.length; i++) {
    var s = sessions[i];
    var last = tsOf(s.lastActivity);
    if (last && now - last < ACTIVE_MS) active++;
    var rc = s.requestCount || 0;
    sumReq += rc;
    if (rc > maxReq) maxReq = rc;
    var tc = s.toolCounts || {};
    for (var k in tc) {
      if (Object.prototype.hasOwnProperty.call(tc, k)) fleet[k] = (fleet[k] || 0) + tc[k];
    }
  }
  // Prefer the server-derived values when present (kept in sync via derive.ts).
  if (typeof dv.activeSessions === 'number') active = dv.activeSessions;
  var share = typeof dv.topSessionShare === 'number'
    ? dv.topSessionShare
    : (sumReq > 0 ? maxReq / sumReq : 0);

  // Fleet mix → sorted entries (top 4 + "other").
  var mix = [];
  for (var t in fleet) { if (Object.prototype.hasOwnProperty.call(fleet, t)) mix.push([t, fleet[t]]); }
  mix.sort(function (a, b) { return b[1] - a[1]; });
  var mixTotal = mix.reduce(function (acc, e) { return acc + e[1]; }, 0);
  var top = mix.slice(0, 4);
  var otherTotal = mix.slice(4).reduce(function (acc, e) { return acc + e[1]; }, 0);

  return {
    count: sessions.length,
    active: active,
    idle: Math.max(0, sessions.length - active),
    sumReq: sumReq,
    maxReq: maxReq,
    share: share,
    mix: top,
    mixOther: otherTotal,
    mixTotal: mixTotal,
  };
}

function tsOf(v) {
  if (!v) return 0;
  var t = typeof v === 'string' ? Date.parse(v) : v;
  return isFinite(t) ? t : 0;
}

/** Mirror of derive THRESHOLDS.topSessionShare (lower = better). */
function shareState(share) {
  if (share <= 0.5) return 'ok';
  if (share <= 0.8) return 'warn';
  return 'bad';
}

function pillHtml(state, label) {
  return '<span class="pill pill--' + state + '"><span class="dot" aria-hidden="true"></span>' + label + '</span>';
}

// ── summary strip ─────────────────────────────────────────────────────────────

function renderStrip(ctx, st) {
  var fmt = ctx.fmt, $ = ctx.$, setLive = ctx.setLive;

  // Tile 1 — Active / Idle.
  setLive('sessActiveVal', fmt.fmt(st.active) + ' / ' + fmt.fmt(st.idle));
  if ($('sessActiveSub')) $('sessActiveSub').textContent = st.count + ' total · active < 60s';
  if ($('sessActivePill')) {
    $('sessActivePill').innerHTML = st.count === 0
      ? pillHtml('muted', 'idle fleet')
      : pillHtml(st.active > 0 ? 'ok' : 'muted', st.active > 0 ? 'serving' : 'quiet');
  }
  renderActiveBar(ctx, st);

  // Tile 2 — Request concentration (top session's share of all requests).
  var pct = Math.round(st.share * 100);
  setLive('sessConcVal', st.count ? pct + '%' : '—');
  if ($('sessConcSub')) {
    $('sessConcSub').textContent = st.count
      ? 'top session · ' + fmt.fmt(st.maxReq) + ' / ' + fmt.fmt(st.sumReq) + ' reqs'
      : 'no sessions';
  }
  var cState = shareState(st.share);
  if ($('sessConcPill')) {
    $('sessConcPill').innerHTML = st.count
      ? pillHtml(cState, cState === 'ok' ? 'balanced' : cState === 'warn' ? 'skewed' : 'single-source')
      : pillHtml('muted', 'idle');
  }
  var bar = $('sessConcBar');
  if (bar) {
    bar.style.width = Math.max(st.count ? 2 : 0, pct) + '%';
    bar.style.background = cState === 'ok' ? 'var(--ok)' : cState === 'warn' ? 'var(--warn)' : 'var(--err)';
    bar.textContent = st.count && pct >= 12 ? pct + '%' : '';
  }

  // Tile 3 — Fleet tool mix.
  var top = st.mix[0];
  setLive('sessMixVal', top ? top[0] : '—');
  if ($('sessMixSub')) {
    $('sessMixSub').textContent = st.mixTotal
      ? fmt.fmt(st.mixTotal) + ' tool calls · ' + st.mix.length + (st.mixOther ? '+1' : '') + ' tools'
      : 'no tool calls yet';
  }
  renderMixBar(ctx, st);
}

function renderActiveBar(ctx, st) {
  var bar = ctx.$('sessActiveBar');
  if (!bar) return;
  var tot = st.active + st.idle;
  if (!tot) { bar.innerHTML = ''; return; }
  function seg(color, n, label) {
    if (!n) return '';
    return '<div class="seg" style="width:' + ((n / tot) * 100).toFixed(1) + '%;background:' + color + '" aria-label="' + label + '"></div>';
  }
  // Active sessions read as healthy (ok-green); idle as muted/cold.
  bar.innerHTML = seg('var(--ok)', st.active, st.active + ' active') + seg('var(--text-mute)', st.idle, st.idle + ' idle');
}

function renderMixBar(ctx, st) {
  var esc = ctx.esc;
  var bar = ctx.$('sessMixBar');
  var legend = ctx.$('sessMixLegend');
  if (!bar) return;
  if (!st.mixTotal) {
    bar.innerHTML = '';
    if (legend) legend.innerHTML = '';
    return;
  }
  var segs = st.mix.map(function (e, i) {
    var w = (e[1] / st.mixTotal) * 100;
    return '<div class="seg" style="width:' + w.toFixed(1) + '%;background:' + MIX_COLORS[i] + '"'
      + ' aria-label="' + esc(e[0]) + ' ' + e[1] + '"></div>';
  });
  if (st.mixOther) {
    var ow = (st.mixOther / st.mixTotal) * 100;
    segs.push('<div class="seg" style="width:' + ow.toFixed(1) + '%;background:' + MIX_COLORS[4] + '"'
      + ' aria-label="other ' + st.mixOther + '"></div>');
  }
  bar.innerHTML = segs.join('');

  if (legend) {
    var items = st.mix.map(function (e, i) {
      var pct = Math.round((e[1] / st.mixTotal) * 100);
      return '<span><i style="background:' + MIX_COLORS[i] + '"></i>' + esc(e[0]) + ' ' + pct + '%</span>';
    });
    if (st.mixOther) {
      var opct = Math.round((st.mixOther / st.mixTotal) * 100);
      items.push('<span><i style="background:' + MIX_COLORS[4] + '"></i>other ' + opct + '%</span>');
    }
    legend.innerHTML = items.join('');
  }
}

// ── so-what line ───────────────────────────────────────────────────────────────

function renderSoWhat(ctx, st) {
  var sw = ctx.$('sessSoWhat');
  if (!sw) return;
  if (!st.count) {
    sw.innerHTML = '<span>No active sessions — the fleet is idle.</span>';
    return;
  }
  var pct = Math.round(st.share * 100);
  var top = st.mix[0];
  var mixPct = top && st.mixTotal ? Math.round((top[1] / st.mixTotal) * 100) : 0;
  var parts = '<b>' + st.count + '</b> session' + (st.count === 1 ? '' : 's')
    + ', <b>' + st.active + '</b> active';
  if (st.count) parts += ' · top session = <b>' + pct + '%</b> of requests';
  if (top) parts += ' · fleet is <b>' + mixPct + '%</b> ' + ctx.esc(top[0]);
  sw.innerHTML = '<span>' + parts + '</span>';
}

// ── per-session detail table ────────────────────────────────────────────────

function renderTable(ctx, sessions, st) {
  var fmt = ctx.fmt, esc = ctx.esc;
  var tbody = ctx.$('sessionsTableBody');
  if (!tbody) return;

  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="9">'
      + '<div class="empty">'
      + '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg>'
      + '<div class="empty-title">No active sessions</div>'
      + '<div class="empty-msg" style="padding:0">Connected MCP clients will appear here.</div>'
      + '</div></td></tr>';
    return;
  }

  var now = Date.now();
  tbody.innerHTML = sessions.map(function (s) {
    var ci = s.clientInfo;
    var clientStr = ci
      ? esc((ci.sub || '') + (ci.clientId ? ' (' + ci.clientId.slice(0, 8) + ')' : '')) || '—'
      : '—';

    // Idle indicator: relative age + a health dot (active < 60s).
    var lastTs = tsOf(s.lastActivity);
    var isActive = lastTs && (now - lastTs < ACTIVE_MS);
    var idleCell = '<span class="cell-dot" style="background:' + (isActive ? 'var(--ok)' : 'var(--text-mute)') + '"'
      + ' aria-label="' + (isActive ? 'active' : 'idle') + '"></span>'
      + '<span class="mono" style="color:var(--text-dim)">' + esc(fmt.fmtAgo(s.lastActivity)) + '</span>';

    // Recent tools as a left→right recency chip sequence (oldest → newest).
    // Newest call is emphasized (info badge); older calls fade to muted.
    var lastTools = s.lastTools || [];
    var chips = lastTools.length
      ? lastTools.map(function (t, i) {
          var fresh = i >= lastTools.length - 1;     // newest gets full emphasis
          var cls = fresh ? 'badge badge--info' : 'badge badge--muted';
          return '<span class="' + cls + '"' + (fresh ? '' : ' style="opacity:.7"') + '>' + esc(t) + '</span>';
        }).join('')
      : '<span style="color:var(--text-mute)">—</span>';

    // Top tools for this session as a compact stacked sparbar (top 3).
    var tcEntries = [];
    var tc = s.toolCounts || {};
    for (var k in tc) { if (Object.prototype.hasOwnProperty.call(tc, k)) tcEntries.push([k, tc[k]]); }
    tcEntries.sort(function (a, b) { return b[1] - a[1]; });
    var top3 = tcEntries.slice(0, 3);
    var topTotal = top3.reduce(function (acc, e) { return acc + e[1]; }, 0) || 1;
    var topBar = top3.length
      ? '<div class="stacked-bar stacked-bar--sm" style="margin-top:0;min-width:90px" title="'
          + esc(top3.map(function (e) { return e[0] + ':' + e[1]; }).join(', ')) + '">'
          + top3.map(function (e, i) {
              return '<div class="seg" style="width:' + ((e[1] / topTotal) * 100).toFixed(1) + '%;background:'
                + MIX_COLORS[i] + '" aria-label="' + esc(e[0]) + ' ' + e[1] + '"></div>';
            }).join('')
          + '</div>'
      : '<span style="color:var(--text-mute)">—</span>';

    return '<tr>'
      + '<td title="' + esc(s.sessionId) + '" style="cursor:help"><span class="mono">' + esc(fmt.truncate(s.sessionId, 8)) + '</span></td>'
      + '<td><span class="mono">' + esc(s.ip || '—') + '</span></td>'
      + '<td>' + clientStr + '</td>'
      + '<td><span class="mono" style="color:var(--text-dim)">' + esc(fmt.fmtDate(s.createdAt)) + '</span></td>'
      + '<td>' + idleCell + '</td>'
      + '<td class="num">' + fmt.fmt(s.requestCount) + '</td>'
      + '<td><div style="display:flex;flex-wrap:wrap;gap:.25rem;align-items:center">' + chips + '</div></td>'
      + '<td>' + topBar + '</td>'
      + '<td><button type="button" class="btn btn-danger btn--sm" onclick="cortex.kill(\'' + esc(s.sessionId) + '\')">Kill</button></td>'
      + '</tr>';
  }).join('');
  void st;
}
