// memories.js — Memories tab: inbox + detail drawer + editor (ES module).
//
// Deep link: #memories/<vault path>. The list is fetched on demand from
// /dashboard/api/memories (defaults to "stored in the last 24 h"); the drawer
// from /dashboard/api/memories/note. Writes are POSTs (CSRF header added by the
// core fetch patch): update (etag-checked), archive, noise, delete. Archive is
// the safe default; delete sits behind a confirm dialog that says it cannot be
// undone.

import { renderMarkdown } from '../lib/md.js';

/** @typedef {import('../core.js').Ctx} Ctx */

var listLoaded = false;
var selected = '';
var detail = null;
var editing = false;
var debounceT = 0;

export default {
  id: 'memories',

  init(el, ctx) {
    var form = ctx.$('memFilters');
    form.addEventListener('submit', function (ev) { ev.preventDefault(); loadList(ctx); });
    form.addEventListener('change', function (ev) {
      if (ev.target && ev.target.tagName !== 'INPUT' || (ev.target.type === 'checkbox')) loadList(ctx);
    });
    form.addEventListener('input', function (ev) {
      if (!ev.target || ev.target.tagName !== 'INPUT' || ev.target.type === 'checkbox') return;
      clearTimeout(debounceT);
      debounceT = setTimeout(function () { loadList(ctx); }, 350);
    });
    ctx.$('memList').addEventListener('click', function (ev) {
      var row = ev.target.closest('[data-mem-path]');
      if (!row) return;
      ev.preventDefault();
      var p = row.getAttribute('data-mem-path');
      ctx.setRoute(p);
      openDetail(ctx, p, true);
    });
    ctx.$('memDetail').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-mem-act]');
      if (!b) return;
      ev.preventDefault();
      act(ctx, b.getAttribute('data-mem-act'));
    });
  },

  route(el, ctx, rest) {
    if (!listLoaded) { listLoaded = true; loadList(ctx); }
    if (rest && rest !== selected) openDetail(ctx, rest, false);
    if (!rest && selected) { selected = ''; detail = null; renderEmptyDetail(ctx); markSelected(ctx); }
  },

  refresh() {},
};

// ── List ─────────────────────────────────────────────────────────────────────

function sinceParam(v) {
  if (v === 'all') return 'all';
  var days = parseInt(v, 10) || 1;
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function loadList(ctx) {
  var p = new URLSearchParams();
  var v = function (id) { var el = ctx.$(id); return el ? el.value.trim() : ''; };
  if (v('memQ')) p.set('q', v('memQ'));
  p.set('since', sinceParam(v('memSince')));
  ['category:memCategory', 'temperature:memTemp', 'agent:memAgent', 'machine:memMachine',
   'project:memProject', 'source:memSource'].forEach(function (pair) {
    var kv = pair.split(':');
    if (v(kv[1])) p.set(kv[0], v(kv[1]));
  });
  if (ctx.$('memArchived').checked) p.set('archived', '1');
  if (ctx.$('memAll').checked) p.set('all', '1');
  var list = ctx.$('memList');
  list.setAttribute('aria-busy', 'true');
  ctx.fetchJson('/dashboard/api/memories?' + p.toString())
    .then(function (d) { fillFacets(ctx, d.facets || {}); renderList(ctx, d); })
    .catch(function (e) { list.innerHTML = '<div class="state-error" role="alert">Could not load memories: ' + ctx.esc(e.message) + '</div>'; })
    .finally(function () { list.removeAttribute('aria-busy'); });
}

function fillFacets(ctx, f) {
  [['memCategory', f.categories], ['memTemp', f.temperatures]].forEach(function (pair) {
    var sel = ctx.$(pair[0]);
    if (!sel || !pair[1] || sel.options.length > 1) return;
    sel.insertAdjacentHTML('beforeend', pair[1].map(function (c) {
      return '<option value="' + ctx.escAttr(c) + '">' + ctx.esc(c) + '</option>';
    }).join(''));
  });
}

function renderList(ctx, d) {
  var items = d.items || [];
  var sinceLabel = ctx.$('memSince').selectedOptions[0] ? ctx.$('memSince').selectedOptions[0].textContent : '';
  ctx.$('memCount').textContent = items.length + (d.total > items.length ? ' of ' + d.total : '') + ' · ' + sinceLabel
    + (d.truncated ? ' · narrowed (refine filters)' : '');
  if (!items.length) {
    ctx.$('memList').innerHTML = '<div class="empty"><div class="empty-title">Nothing stored in this window</div>'
      + '<div class="empty-msg" style="padding:0">Widen “Stored” to 7 days or any time, or clear the filters.</div></div>';
    return;
  }
  ctx.$('memList').innerHTML = items.map(function (it) {
    var t = it.temperature || 'unset';
    var tempCls = t === 'hot' ? 'badge-hot' : t === 'warm' ? 'badge-warm' : t === 'cold' ? 'badge-cold' : 'badge--muted';
    var prov = [it.agent, it.machine, it.project, it.source].filter(Boolean).join(' · ');
    return '<a role="listitem" class="mem-row' + (it.path === selected ? ' is-selected' : '') + '" href="#memories/'
      + ctx.escAttr(it.path.split('/').map(encodeURIComponent).join('/')) + '" data-mem-path="' + ctx.escAttr(it.path) + '"'
      + (it.path === selected ? ' aria-current="true"' : '') + '>'
      + '<div class="mem-row-top"><span class="mem-row-title">' + ctx.esc(it.title) + '</span>'
      + '<span class="mono mem-row-date">' + ctx.esc((it.date || '').slice(0, 10)) + '</span></div>'
      + '<div class="mem-row-meta"><span class="badge ' + tempCls + '">' + ctx.esc(t) + '</span>'
      + (it.category ? '<span class="badge badge--muted">' + ctx.esc(it.category) + '</span>' : '')
      + (it.archived ? '<span class="badge badge--warn">archived</span>' : '')
      + (prov ? '<span class="card-sub mono mem-prov">' + ctx.esc(prov) + '</span>' : '') + '</div>'
      + '<div class="mem-row-snippet">' + ctx.esc(it.snippet) + '</div>'
      + '</a>';
  }).join('');
}

function markSelected(ctx) {
  ctx.$('memList').querySelectorAll('[data-mem-path]').forEach(function (r) {
    var on = r.getAttribute('data-mem-path') === selected;
    r.classList.toggle('is-selected', on);
    if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
  });
}

// ── Detail drawer ────────────────────────────────────────────────────────────

function renderEmptyDetail(ctx) {
  ctx.$('memDetail').innerHTML = '<div class="empty"><div class="empty-title">Nothing selected</div>'
    + '<div class="empty-msg" style="padding:0">Pick a memory from the inbox to read, edit, archive or delete it.</div></div>';
}

function openDetail(ctx, path, focus) {
  selected = path;
  editing = false;
  markSelected(ctx);
  var box = ctx.$('memDetail');
  box.innerHTML = '<div class="skel skel--line"></div><div class="skel skel--line"></div><div class="skel skel--line"></div>';
  ctx.fetchJson('/dashboard/api/memories/note?path=' + encodeURIComponent(path))
    .then(function (d) {
      if (selected !== path) return;
      detail = d;
      renderDetail(ctx);
      if (focus) {
        var drawer = ctx.$('memDrawer');
        drawer.focus({ preventScroll: true });
        if (window.matchMedia('(max-width: 900px)').matches) drawer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    })
    .catch(function (e) { box.innerHTML = '<div class="state-error" role="alert">Could not open ' + ctx.esc(path) + ': ' + ctx.esc(e.message) + '</div>'; });
}

function kv(ctx, label, value) {
  if (value == null || value === '') value = '—';
  if (typeof value === 'object') value = JSON.stringify(value);
  return '<dt>' + ctx.esc(label) + '</dt><dd class="mono">' + ctx.esc(String(value)) + '</dd>';
}

function linkList(ctx, paths, emptyTxt) {
  if (!paths || !paths.length) return '<div class="empty-msg" style="padding:0">' + emptyTxt + '</div>';
  return '<ul class="mem-links">' + paths.slice(0, 60).map(function (p) {
    var path = /\.md$/.test(p) ? p : p + '.md';
    return '<li><a href="#memories/' + ctx.escAttr(path.split('/').map(encodeURIComponent).join('/')) + '">' + ctx.esc(p) + '</a></li>';
  }).join('') + (paths.length > 60 ? '<li class="card-sub">+' + (paths.length - 60) + ' more</li>' : '') + '</ul>';
}

function renderDetail(ctx) {
  var d = detail, esc = ctx.esc;
  if (!d) return renderEmptyDetail(ctx);
  var fm = d.frontmatter || {};
  var h = d.heat || {}, s = d.supersession || {}, pv = d.provenance || {};
  var obs = ctx.obsidianLink(d.path);
  var actions = '<div class="mem-actions" role="group" aria-label="Memory actions">'
    + '<button type="button" class="btn btn--sm" data-mem-act="edit">Edit</button>'
    + (d.archived ? '' : '<button type="button" class="btn btn--sm" data-mem-act="archive">Archive</button>')
    + '<button type="button" class="btn btn--sm" data-mem-act="noise">Mark as noise</button>'
    + '<button type="button" class="btn btn--sm btn-danger" data-mem-act="delete">Delete…</button>'
    + '</div>';
  var head = '<div class="mem-detail-head">'
    + '<h2 class="mem-detail-title">' + esc(d.title) + '</h2>'
    + '<div class="card-sub mono">' + esc(d.path) + '</div>'
    + '<div class="mem-row-meta">'
    + (h.temperature ? '<span class="badge badge--info">' + esc(h.temperature) + '</span>' : '')
    + (fm.category ? '<span class="badge badge--muted">' + esc(String(fm.category)) + '</span>' : '')
    + (d.archived ? '<span class="badge badge--warn">archived</span>' : '')
    + (fm.noise ? '<span class="badge badge--warn">noise</span>' : '')
    + (obs ? ' ' + obs : '')
    + '</div>' + actions + '</div>';

  if (editing) { ctx.$('memDetail').innerHTML = head + editorHtml(ctx, d); wireEditor(ctx); return; }

  var supersessionRows = kv(ctx, 'Superseded by', s.supersededBy) + kv(ctx, 'Supersedes', s.supersedes)
    + kv(ctx, 'Consolidated into', s.consolidatedInto) + kv(ctx, 'Contradicts', s.contradicts)
    + kv(ctx, 'Valid from', s.validFrom) + kv(ctx, 'Valid to', s.validTo);
  ctx.$('memDetail').innerHTML = head
    + '<section class="mem-sec"><h3 class="card-label">Content</h3><div class="md-body">' + renderMarkdown(d.body) + '</div></section>'
    + '<div class="mem-sec-grid">'
    + '<section class="mem-sec"><h3 class="card-label">Provenance</h3><dl class="kv">'
    + kv(ctx, 'Created', fm.created) + kv(ctx, 'Updated', fm.last_updated)
    + kv(ctx, 'Agent', pv.agent) + kv(ctx, 'Machine', pv.machine) + kv(ctx, 'Project', pv.project) + kv(ctx, 'Source', pv.source)
    + kv(ctx, 'Id', fm.id) + '</dl></section>'
    + '<section class="mem-sec"><h3 class="card-label">Heat &amp; access</h3><dl class="kv">'
    + kv(ctx, 'Temperature', h.temperature) + kv(ctx, 'Heat score', h.heatScore) + kv(ctx, 'Importance', h.importance)
    + kv(ctx, 'Access count', h.accessCount) + kv(ctx, 'Last accessed', h.lastAccessed) + '</dl></section>'
    + '</div>'
    + '<section class="mem-sec"><h3 class="card-label">Supersession</h3><dl class="kv">' + supersessionRows + '</dl></section>'
    + '<div class="mem-sec-grid">'
    + '<section class="mem-sec"><h3 class="card-label">Links out (' + (d.linksOut || []).length + ')</h3>' + linkList(ctx, d.linksOut, 'No outgoing links.') + '</section>'
    + '<section class="mem-sec"><h3 class="card-label">Links in (' + (d.linksIn || []).length + ')</h3>' + linkList(ctx, d.linksIn, 'Nothing links here yet.') + '</section>'
    + '</div>'
    + '<details class="mem-sec"><summary class="card-label">Raw frontmatter</summary><pre class="md-pre">' + esc(JSON.stringify(fm, null, 2)) + '</pre></details>';
}

var IMPORTANCE = ['', 'low', 'medium', 'high', 'critical'];
var TEMPS = ['', 'hot', 'warm', 'cold'];
var CATS = ['', 'observation', 'decision', 'insight', 'conversation', 'fact', 'preference', 'plan', 'reflection'];

function selectHtml(ctx, id, label, options, value) {
  var opts = options.slice();
  if (value && opts.indexOf(value) < 0) opts.push(value);
  return '<div class="field"><label class="field-label" for="' + id + '">' + label + '</label><select class="select" id="' + id + '">'
    + opts.map(function (o) { return '<option value="' + ctx.escAttr(o) + '"' + (o === value ? ' selected' : '') + '>' + ctx.esc(o || '—') + '</option>'; }).join('')
    + '</select></div>';
}

function editorHtml(ctx, d) {
  var fm = d.frontmatter || {};
  var tags = Array.isArray(fm.tags) ? fm.tags.join(', ') : (fm.tags || '');
  return '<form class="mem-editor" id="memEditor">'
    + '<div class="filter-grid">'
    + '<div class="field filter-wide"><label class="field-label" for="meTitle">Title</label><input class="input" id="meTitle" value="' + ctx.escAttr(String(fm.title || d.title || '')) + '"></div>'
    + selectHtml(ctx, 'meCategory', 'Category', CATS, String(fm.category || ''))
    + selectHtml(ctx, 'meImportance', 'Importance', IMPORTANCE, String(fm.importance || ''))
    + selectHtml(ctx, 'meTemp', 'Temperature', TEMPS, String(fm.temperature || ''))
    + '<div class="field filter-wide"><label class="field-label" for="meTags">Tags (comma-separated)</label><input class="input mono" id="meTags" value="' + ctx.escAttr(String(tags)) + '"></div>'
    + '</div>'
    + '<div class="field"><label class="field-label" for="meBody">Content (markdown)</label><textarea class="textarea mono" id="meBody" rows="14">' + ctx.esc(d.body || '') + '</textarea></div>'
    + '<div class="dlg-actions"><button type="button" class="btn" data-mem-act="cancel">Cancel</button>'
    + '<button type="submit" class="btn btn-primary">Save</button></div>'
    + '<div class="card-sub">Other frontmatter (id, links, heat history, validity…) is preserved as-is.</div>'
    + '</form>';
}

function wireEditor(ctx) {
  var f = ctx.$('memEditor');
  if (!f) return;
  ctx.$('meTitle').focus();
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    ctx.postJson('/dashboard/api/memories/update', {
      path: detail.path, etag: detail.etag, body: ctx.$('meBody').value,
      fields: {
        title: ctx.$('meTitle').value, category: ctx.$('meCategory').value, importance: ctx.$('meImportance').value,
        temperature: ctx.$('meTemp').value, tags: ctx.$('meTags').value,
      },
    }).then(function () {
      ctx.toast('Saved', 'success');
      openDetail(ctx, detail.path, false);
      loadList(ctx);
    }).catch(function (e) { ctx.toast(e.message, 'error'); btn.disabled = false; });
  });
}

// ── Actions ──────────────────────────────────────────────────────────────────

function confirmDialog(ctx, opts) {
  var dlg = ctx.$('memConfirm');
  ctx.$('memConfirmTitle').textContent = opts.title;
  ctx.$('memConfirmText').textContent = opts.text;
  ctx.$('memConfirmReasonWrap').hidden = !opts.reason;
  ctx.$('memConfirmReason').value = '';
  var ok = ctx.$('memConfirmOk');
  ok.textContent = opts.ok;
  ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
  return new Promise(function (resolve) {
    dlg.addEventListener('close', function onClose() {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' ? { reason: ctx.$('memConfirmReason').value.trim() } : null);
    });
    dlg.returnValue = '';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else resolve(window.confirm(opts.text) ? { reason: '' } : null);
    if (opts.reason) ctx.$('memConfirmReason').focus(); else ok.focus();
  });
}

function act(ctx, kind) {
  if (!detail) return;
  var path = detail.path;
  if (kind === 'edit') { editing = true; renderDetail(ctx); return; }
  if (kind === 'cancel') { editing = false; renderDetail(ctx); return; }
  if (kind === 'archive') {
    confirmDialog(ctx, { title: 'Archive this memory?', text: 'It stays in the vault (marked archived, cold) and drops out of normal recall. You can un-archive it by editing its frontmatter.', ok: 'Archive', reason: true })
      .then(function (r) { if (r) done(ctx, ctx.postJson('/dashboard/api/memories/archive', { path: path, reason: r.reason }), 'Archived', false); });
  } else if (kind === 'noise') {
    confirmDialog(ctx, { title: 'Mark as noise?', text: 'Archives the memory and tags it “noise” so it stops surfacing. Nothing is deleted.', ok: 'Mark as noise' })
      .then(function (r) { if (r) done(ctx, ctx.postJson('/dashboard/api/memories/noise', { path: path }), 'Marked as noise', false); });
  } else if (kind === 'delete') {
    confirmDialog(ctx, { title: 'Delete permanently?', text: 'This removes ' + path + ' from disk and every index. It cannot be undone. Archive is the safer choice if you might need it again.', ok: 'Delete forever', danger: true, reason: true })
      .then(function (r) { if (r) done(ctx, ctx.postJson('/dashboard/api/memories/delete', { path: path, reason: r.reason || 'deleted from dashboard', confirm: true }), 'Deleted', true); });
  }
}

function done(ctx, p, msg, gone) {
  p.then(function () {
    ctx.toast(msg, 'success');
    if (gone) { selected = ''; detail = null; ctx.setRoute(''); renderEmptyDetail(ctx); }
    else openDetail(ctx, detail.path, false);
    loadList(ctx);
  }).catch(function (e) { ctx.toast(e.message, 'error'); });
}
