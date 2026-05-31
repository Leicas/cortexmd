// ratelimits.js — Rate Limits tab client module (ES module, no build).
// Migrated verbatim from the legacy `renderRateLimits` + `resetRateLimitAction`.
// Reads only from ctx.data. See ARCHITECTURE.md §3/§4.

/** @typedef {import('../core.js').Ctx} Ctx */

export default {
  id: 'ratelimits',

  /** One-time: register the per-row reset action on the cortex namespace. */
  init(el, ctx) {
    window.cortex = window.cortex || {};
    // Legacy `resetRateLimitAction(key)` — server-rendered rows call it.
    window.cortex.resetRl = function (key) {
      ctx.postAction('/dashboard/api/rate-limit/reset', { key: key });
    };
  },

  /** Idempotent: render from ctx.data. Runs on activate + each SSE push. */
  refresh(el, ctx) {
    var fmt = ctx.fmt;
    var esc = ctx.esc;
    var limits = ctx.data.rateLimits || [];
    var tbody = ctx.$('rateLimitTableBody');
    if (!tbody) return;
    if (!limits.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-msg" style="text-align:center">No IPs currently being tracked</td></tr>';
      return;
    }
    tbody.innerHTML = limits.map(function (r) {
      var ip = r.key.replace(/^auth:/, '');
      return '<tr>'
        + '<td>' + esc(ip) + '</td>'
        + '<td>' + fmt.fmt(r.count) + '</td>'
        + '<td>' + fmt.fmt(r.remaining) + '</td>'
        + '<td>' + fmt.fmtDate(r.resetAt) + '</td>'
        + '<td><button class="btn btn-danger" onclick="cortex.resetRl(\'' + esc(r.key) + '\')">Reset</button></td>'
        + '</tr>';
    }).join('');
  },
};
