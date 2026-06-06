// oauth.js — OAuth Clients tab client module (ES module, no build).
// Self-service OAuth client management. Unlike the SSE-fed tabs, this one owns
// a one-shot GET (/dashboard/api/oauth/clients) on activate + after mutations;
// it ignores ctx.data. Create/delete go through cortex.oauth* action globals
// (server-rendered buttons reference them). See ARCHITECTURE.md.

/** @typedef {import('../core.js').Ctx} Ctx */

var loaded = false;

function postOpts(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default {
  id: 'oauth',

  /** One-time: wire the action globals the server-rendered buttons call. */
  init(el, ctx) {
    window.cortex = window.cortex || {};

    window.cortex.oauthCreate = function () {
      var nameEl = document.getElementById('oauthClientName');
      var urisEl = document.getElementById('oauthRedirectUris');
      var name = (nameEl && nameEl.value || 'n8n').trim() || 'n8n';
      var uris = (urisEl && urisEl.value || '')
        .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!uris.length) {
        ctx.toast('Enter at least one redirect URL (the one n8n shows you)', 'error');
        return;
      }
      ctx.fetchJson('/dashboard/api/oauth/clients/create', postOpts({ client_name: name, redirect_uris: uris }))
        .then(function (d) {
          if (!d || !d.client_id) { ctx.toast((d && d.error) || 'Create failed', 'error'); return; }
          ctx.toast('Client created', 'success');
          renderResult(ctx, d);
          load(ctx);
        })
        .catch(function (e) { ctx.toast('Request failed: ' + e.message, 'error'); });
    };

    window.cortex.oauthDelete = function (clientId, name) {
      if (!confirm('Delete OAuth client "' + (name || clientId) + '"?\nAny credential using it will stop working until re-registered.')) return;
      ctx.fetchJson('/dashboard/api/oauth/clients/delete', postOpts({ client_id: clientId }))
        .then(function (d) {
          if (d && d.ok) { ctx.toast('Client deleted', 'success'); load(ctx); }
          else ctx.toast((d && d.error) || 'Delete failed', 'error');
        })
        .catch(function (e) { ctx.toast('Request failed: ' + e.message, 'error'); });
    };

    load(ctx);
  },

  /** This tab is GET-driven, not SSE-driven. Only (re)load if we never have. */
  refresh(el, ctx) {
    if (!loaded) load(ctx);
  },
};

// ── data load ────────────────────────────────────────────────────────────────

function load(ctx) {
  ctx.fetchJson('/dashboard/api/oauth/clients')
    .then(function (d) {
      loaded = true;
      renderEndpoints(ctx, (d && d.endpoints) || {});
      renderClients(ctx, (d && d.clients) || []);
    })
    .catch(function (e) { ctx.toast('Failed to load OAuth clients: ' + e.message, 'error'); });
}

function renderEndpoints(ctx, ep) {
  if (ctx.$('oauthAuthUrl')) ctx.$('oauthAuthUrl').textContent = ep.authorizationUrl || '—';
  if (ctx.$('oauthTokenUrl')) ctx.$('oauthTokenUrl').textContent = ep.tokenUrl || '—';
}

// ── created-client result (secret shown once) ─────────────────────────────────

function renderResult(ctx, d) {
  var box = ctx.$('oauthCreateResult');
  if (!box) return;
  var esc = ctx.esc;
  box.innerHTML =
    '<div class="state-error" role="status" style="flex-direction:column;align-items:stretch;gap:.5rem">'
    + '<div><b>Copy the secret now</b> — it is shown only once and cannot be retrieved later.</div>'
    + '<div style="display:grid;grid-template-columns:7rem 1fr;gap:.4rem;align-items:baseline">'
    + '<div class="card-label" style="margin:0">Client ID</div>'
    + '<span class="mono" title="Click to copy" style="cursor:pointer;word-break:break-all" onclick="cortex.copyLogLine(this)">' + esc(d.client_id) + '</span>'
    + '<div class="card-label" style="margin:0">Client Secret</div>'
    + '<span class="mono" title="Click to copy" style="cursor:pointer;word-break:break-all" onclick="cortex.copyLogLine(this)">' + esc(d.client_secret) + '</span>'
    + '</div></div>';
}

// ── existing-clients table ─────────────────────────────────────────────────────

function renderClients(ctx, clients) {
  var tbody = ctx.$('oauthClientsBody');
  if (!tbody) return;
  var esc = ctx.esc, fmt = ctx.fmt;

  if (!clients.length) {
    tbody.innerHTML = '<tr><td colspan="5">'
      + '<div class="empty">'
      + '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 12h6"/></svg>'
      + '<div class="empty-title">No registered clients</div>'
      + '<div class="empty-msg" style="padding:0">Register one above to connect n8n.</div>'
      + '</div></td></tr>';
    return;
  }

  tbody.innerHTML = clients.map(function (c) {
    var uris = (c.redirect_uris || []).map(function (u) {
      return '<div class="mono" style="word-break:break-all;color:var(--text-dim)">' + esc(u) + '</div>';
    }).join('') || '<span style="color:var(--text-mute)">—</span>';
    var nameForJs = String(c.client_name || '').replace(/'/g, "\\'");
    return '<tr>'
      + '<td>' + esc(c.client_name || '—') + '</td>'
      + '<td><span class="mono" title="' + esc(c.client_id) + '" style="word-break:break-all">' + esc(c.client_id) + '</span></td>'
      + '<td>' + uris + '</td>'
      + '<td><span class="mono" style="color:var(--text-dim)">' + esc(fmt.fmtDate(c.registeredAt)) + '</span></td>'
      + '<td><button type="button" class="btn btn-danger btn--sm" onclick="cortex.oauthDelete(\'' + esc(c.client_id) + '\',\'' + esc(nameForJs) + '\')">Revoke</button></td>'
      + '</tr>';
  }).join('');
}
