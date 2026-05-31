// sessions.js — Sessions tab client module (ES module, no build).
// Migrated verbatim from the legacy `renderSessions` + `killSessionAction`.
// Reads only from ctx.data. See ARCHITECTURE.md §3/§4.

/** @typedef {import('../core.js').Ctx} Ctx */

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
    var fmt = ctx.fmt, esc = ctx.esc;
    var sessions = ctx.data.sessions || [];
    var tbody = ctx.$('sessionsTableBody');
    if (!tbody) return;
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty-msg" style="text-align:center">No active sessions</td></tr>';
      return;
    }
    tbody.innerHTML = sessions.map(function (s) {
      var ci = s.clientInfo;
      var clientStr = ci ? esc((ci.sub || '') + (ci.clientId ? ' (' + ci.clientId.slice(0, 8) + ')' : '')) : '—';
      var recentTools = (s.lastTools || []).map(function (t) {
        return '<span style="color:var(--blue);margin-right:.3rem">' + esc(t) + '</span>';
      }).join('');
      var tc = s.toolCounts || {};
      var tcEntries = [];
      for (var k in tc) { if (Object.prototype.hasOwnProperty.call(tc, k)) tcEntries.push([k, tc[k]]); }
      tcEntries.sort(function (a, b) { return b[1] - a[1]; });
      var toolBreakdown = tcEntries.slice(0, 5).map(function (e) { return esc(e[0]) + ':' + e[1]; }).join(', ');
      if (tcEntries.length > 5) toolBreakdown += ' +' + (tcEntries.length - 5) + ' more';
      return '<tr>'
        + '<td title="' + esc(s.sessionId) + '" style="cursor:help">' + esc(fmt.truncate(s.sessionId, 8)) + '</td>'
        + '<td>' + esc(s.ip || '—') + '</td>'
        + '<td>' + clientStr + '</td>'
        + '<td>' + fmt.fmtDate(s.createdAt) + '</td>'
        + '<td>' + fmt.fmtAgo(s.lastActivity) + '</td>'
        + '<td>' + fmt.fmt(s.requestCount) + '</td>'
        + '<td style="font-size:.7rem">' + recentTools + '</td>'
        + '<td style="font-size:.7rem;color:var(--text-dim)">' + toolBreakdown + '</td>'
        + '<td><button class="btn btn-danger" onclick="cortex.kill(\'' + esc(s.sessionId) + '\')">Kill</button></td>'
        + '</tr>';
    }).join('');
  },
};
