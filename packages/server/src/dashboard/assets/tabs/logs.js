// logs.js — Logs tab client module (ES module, no build).
// Migrated verbatim from the legacy `renderLogs` (+ its lazy filter wiring).
// Reads only from ctx.data (systemLogs / recentToolCalls / recentErrors /
// recentAuthFailures). Filter listeners are wired once in init(); refresh()
// re-renders all four feeds from the current filter state + payload.
// See ARCHITECTURE.md §3/§4.

/** @typedef {import('../core.js').Ctx} Ctx */

export default {
  id: 'logs',

  /** One-time: wire the log filter controls to re-render on change/input. */
  init(el, ctx) {
    var refresh = () => this.refresh(el, ctx);
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
    var fmt = ctx.fmt, esc = ctx.esc, escAttr = ctx.escAttr, $ = ctx.$;
    var data = ctx.data;

    // ── System logs ──
    var logs = data.systemLogs || [];
    var showDebug = $('logFilterDebug') ? $('logFilterDebug').checked : false;
    var showInfo = $('logFilterInfo') ? $('logFilterInfo').checked : true;
    var showWarn = $('logFilterWarn') ? $('logFilterWarn').checked : true;
    var showError = $('logFilterError') ? $('logFilterError').checked : true;
    var sourceFilter = $('logFilterSource') ? $('logFilterSource').value : 'all';
    var textFilter = (($('logFilterText') && $('logFilterText').value) || '').toLowerCase();

    var filtered = logs.filter(function (l) {
      // Level filter
      if (l.level === 'debug' && !showDebug) return false;
      if (l.level === 'info' && !showInfo) return false;
      if (l.level === 'warn' && !showWarn) return false;
      if (l.level === 'error' && !showError) return false;
      // Source filter
      if (sourceFilter !== 'all' && (l.source || 'general') !== sourceFilter) return false;
      // Text filter
      if (textFilter && l.message.toLowerCase().indexOf(textFilter) === -1) return false;
      return true;
    });

    var slEl = $('systemLogsFeed');
    if (slEl) {
      if (!filtered.length) {
        slEl.innerHTML = '<div class="empty-msg">No logs matching filters (' + logs.length + ' total).</div>';
      } else {
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
    }

    // ── Recent tool calls ──
    var calls = data.recentToolCalls || [];
    var callsEl = $('logToolCalls');
    if (callsEl) {
      if (!calls.length) {
        callsEl.innerHTML = '<div class="empty-msg">No tool calls recorded.</div>';
      } else {
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
    }

    // ── Recent errors ──
    var errors = data.recentErrors || [];
    var errEl = $('logErrors');
    if (errEl) {
      if (!errors.length) {
        errEl.innerHTML = '<div class="empty-msg">No errors recorded.</div>';
      } else {
        errEl.innerHTML = errors.slice().reverse().map(function (e) {
          return '<div class="error-item">'
            + '<span class="e-ts">' + fmt.fmtTime(e.timestamp) + '</span>'
            + '<span class="e-tool">' + esc(e.tool) + '</span>'
            + '<span class="e-msg">' + esc(e.message) + '</span>'
            + '</div>';
        }).join('');
      }
    }

    // ── Auth failures ──
    var authFails = data.recentAuthFailures || [];
    var afBody = $('authFailuresTableBody');
    if (afBody) {
      if (!authFails.length) {
        afBody.innerHTML = '<tr><td colspan="4" class="empty-msg" style="text-align:center">No auth failures recorded.</td></tr>';
      } else {
        afBody.innerHTML = authFails.slice().reverse().map(function (f) {
          return '<tr>'
            + '<td>' + fmt.fmtTime(f.timestamp) + '</td>'
            + '<td>' + esc(f.ip) + '</td>'
            + '<td>' + esc(f.method) + '</td>'
            + '<td>' + esc(f.path) + '</td>'
            + '</tr>';
        }).join('');
      }
    }
  },
};
