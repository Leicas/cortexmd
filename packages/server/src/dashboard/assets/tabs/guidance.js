// guidance.js — Guidance Packs tab client module (ES module, no build).
// GET-driven like the OAuth tab: loads /dashboard/api/guidance/packs on
// activate and after mutations. POST/DELETE go through fetch, which core.js
// patches to send the X-CSRF-Token header. Guide text is third-party content:
// it is only ever written with textContent / ctx.esc, never as HTML.

/** @typedef {import('../core.js').Ctx} Ctx */

var loaded = false;
var BASE = '/dashboard/api/guidance';

function load(ctx) {
  ctx.fetchJson(BASE + '/packs')
    .then(function (d) {
      loaded = true;
      render(ctx, (d && d.packs) || [], d || {});
    })
    .catch(function (e) { ctx.toast('Failed to load guidance packs: ' + e.message, 'error'); });
}

function render(ctx, packs, meta) {
  var esc = ctx.esc, escAttr = ctx.escAttr;
  var hosts = ctx.$('guidanceHosts');
  if (hosts) {
    hosts.textContent = meta.admin === false
      ? 'runtime add/remove disabled (GUIDANCE_PACKS_ADMIN=off)'
      : 'allowed hosts: ' + ((meta.allowedHosts || []).join(', ') || 'none');
  }
  var tbody = ctx.$('guidancePacksBody');
  if (!tbody) return;
  if (!packs.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><div class="empty-title">No guidance packs</div>'
      + '<div class="empty-msg" style="padding:0">Add one below, or declare it in GUIDANCE_PACKS.</div></div></td></tr>';
    return;
  }
  tbody.innerHTML = packs.map(function (p) {
    var name = String(p.name || '');
    var actions = '<button type="button" class="btn btn--sm" data-cx-click="cortex.guidanceSync(\'' + escAttr(name) + '\')">Sync</button> '
      + '<button type="button" class="btn btn--sm" data-cx-click="cortex.guidanceRemove(\'' + escAttr(name) + '\')">Remove</button>';
    return '<tr>'
      + '<td><b>' + esc(name) + '</b>' + (p.installed ? '' : ' <span class="card-label">(not synced)</span>') + '</td>'
      + '<td class="mono" style="word-break:break-all">' + esc(p.source || '') + (p.ref ? ' #' + esc(p.ref) : '') + '</td>'
      + '<td class="mono">' + esc(p.commit ? String(p.commit).slice(0, 12) : '—') + (p.pinned ? ' (pinned)' : '') + '</td>'
      + '<td>' + esc(p.license || (p.licenseFile ? 'see ' + p.licenseFile : '—')) + '</td>'
      + '<td>' + esc(String(p.entries || 0)) + (p.skills ? ' + ' + esc(String(p.skills)) + ' skill(s)' : '') + '</td>'
      + '<td>' + esc(p.syncedAt ? String(p.syncedAt).replace('T', ' ').slice(0, 16) : '—') + '</td>'
      + '<td>' + actions + '</td></tr>';
  }).join('');
}

function showResults(ctx, results) {
  var box = ctx.$('guidanceResults');
  if (!box) return;
  var esc = ctx.esc, escAttr = ctx.escAttr;
  if (!results.length) { box.innerHTML = '<div class="card-label">No matching guide.</div>'; return; }
  box.innerHTML = results.map(function (r) {
    return '<div style="margin-bottom:.5rem"><a href="#guidance" class="mono" data-cx-click="cortex.guidanceOpen(\''
      + escAttr(String(r.pack)) + '\', \'' + escAttr(String(r.id)) + '\')">' + esc(String(r.id)) + '</a>'
      + ' <span class="card-label">' + esc(String(r.pack)) + '</span><div>' + esc(String(r.description || '')) + '</div></div>';
  }).join('');
}

export default {
  id: 'guidance',

  init(el, ctx) {
    window.cortex = window.cortex || {};

    window.cortex.guidanceAdd = function () {
      var name = (ctx.$('guidanceName').value || '').trim();
      var source = (ctx.$('guidanceSource').value || '').trim();
      var ref = (ctx.$('guidanceRef').value || '').trim();
      if (!name || !source) { ctx.toast('Name and git URL are required', 'error'); return; }
      var body = { name: name, source: source };
      if (/^[0-9a-f]{40}$/i.test(ref)) body.commit = ref; else if (ref) body.ref = ref;
      ctx.toast('Fetching pack…', 'info');
      ctx.postJson(BASE + '/packs', body)
        .then(function (d) { ctx.toast('Pack "' + d.pack + '" synced', 'success'); load(ctx); })
        .catch(function (e) { ctx.toast('Add failed: ' + e.message, 'error'); });
    };

    window.cortex.guidanceSync = function (name) {
      ctx.toast('Syncing ' + name + '…', 'info');
      ctx.postJson(BASE + '/packs/' + encodeURIComponent(name) + '/sync', {})
        .then(function () { ctx.toast('Pack synced', 'success'); load(ctx); })
        .catch(function (e) { ctx.toast('Sync failed: ' + e.message, 'error'); });
    };

    window.cortex.guidanceRemove = function (name) {
      if (!confirm('Remove guidance pack "' + name + '"? Its files are deleted from the server.')) return;
      ctx.fetchJson(BASE + '/packs/' + encodeURIComponent(name), { method: 'DELETE' })
        .then(function (d) {
          ctx.toast(d.stillDeclaredInEnv ? 'Files removed (still declared in GUIDANCE_PACKS)' : 'Pack removed', 'success');
          load(ctx);
        })
        .catch(function (e) { ctx.toast('Remove failed: ' + e.message, 'error'); });
    };

    window.cortex.guidanceSearch = function () {
      var q = (ctx.$('guidanceQuery').value || '').trim();
      if (!q) return;
      ctx.fetchJson(BASE + '/search?limit=8&q=' + encodeURIComponent(q))
        .then(function (d) { showResults(ctx, (d && d.results) || []); })
        .catch(function (e) { ctx.toast('Search failed: ' + e.message, 'error'); });
    };

    window.cortex.guidanceOpen = function (pack, id) {
      ctx.fetchJson(BASE + '/get?pack=' + encodeURIComponent(pack) + '&id=' + encodeURIComponent(id))
        .then(function (d) {
          var pre = ctx.$('guidanceGuide');
          if (!pre) return;
          pre.style.display = 'block';
          pre.textContent = (d && d.text) || '';
        })
        .catch(function (e) { ctx.toast('Load failed: ' + e.message, 'error'); });
    };

    var input = ctx.$('guidanceQuery');
    if (input) input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') window.cortex.guidanceSearch(); });
    load(ctx);
  },

  refresh(el, ctx) {
    if (!loaded) load(ctx);
  },
};
