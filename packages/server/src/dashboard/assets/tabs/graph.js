// graph.js — Graph tab client module (ES module, no build).
//
// Fetches the full vault link graph ONCE from /dashboard/api/graph (guarded by
// `graphLoaded`), runs the force sim from ../lib/graph-sim.js, and loads a
// clicked node's note from /dashboard/api/note into a side panel. Graph data is
// NOT in the SSE payload (too large), so refresh() is a no-op. See
// ARCHITECTURE.md §3/§4 and the Agents tab for the one-shot-fetch precedent.

import { ForceGraph } from '../lib/graph-sim.js';

/** @typedef {import('../core.js').Ctx} Ctx */

var fg = null;
var graphLoaded = false;
var nodeIndex = {};      // id (path) -> node
var labelIndex = {};     // basename -> id (first wins)
var lastTotals = null;

export default {
  id: 'graph',

  init(el, ctx) {
    if (!graphLoaded) load(el, ctx);

    var fit = el.querySelector('#graphFit');
    if (fit && !fit.dataset.listener) {
      fit.addEventListener('click', function () { if (fg) fg.zoomToFit(); });
      fit.dataset.listener = '1';
    }
    var reheat = el.querySelector('#graphReheat');
    if (reheat && !reheat.dataset.listener) {
      reheat.addEventListener('click', function () { if (fg) fg.reheat(0.7); });
      reheat.dataset.listener = '1';
    }
    var limit = el.querySelector('#graphLimit');
    if (limit && !limit.dataset.listener) {
      limit.addEventListener('change', function () { graphLoaded = false; load(el, ctx); });
      limit.dataset.listener = '1';
    }
    var search = el.querySelector('#graphSearch');
    if (search && !search.dataset.listener) {
      search.addEventListener('change', function () { focusByQuery(el, ctx, search.value); });
      search.dataset.listener = '1';
    }
  },

  // Graph data is fetched once (not in SSE); nothing to do per tick.
  refresh() {},
};

function load(el, ctx) {
  var limitEl = el.querySelector('#graphLimit');
  var limit = limitEl ? limitEl.value : '800';
  var loading = el.querySelector('#graphLoading');
  if (loading) { loading.style.display = ''; loading.textContent = 'Loading graph…'; }

  ctx.fetchJson('/dashboard/api/graph?limit=' + encodeURIComponent(limit))
    .then(function (data) {
      nodeIndex = {};
      labelIndex = {};
      (data.nodes || []).forEach(function (n) {
        nodeIndex[n.id] = n;
        if (labelIndex[n.label] == null) labelIndex[n.label] = n.id;
      });
      lastTotals = { shown: (data.nodes || []).length, total: data.totalNodes, truncated: data.truncated, edges: data.totalEdges };

      var canvas = el.querySelector('#graphCanvas');
      if (!canvas) return;
      if (!fg) {
        fg = ForceGraph(canvas, { nodes: data.nodes, edges: data.edges });
        fg.onNodeClick(function (node) { loadNote(el, ctx, node.id); });
      } else {
        fg.setData({ nodes: data.nodes, edges: data.edges });
      }
      graphLoaded = true;
      if (loading) loading.style.display = 'none';
      renderStat(el);
    })
    .catch(function () {
      if (loading) loading.textContent = 'Failed to load graph.';
    });
}

function renderStat(el) {
  var stat = el.querySelector('#graphStat');
  if (!stat || !lastTotals) return;
  var t = lastTotals;
  stat.textContent = t.truncated
    ? ('showing ' + t.shown + ' of ' + t.total + ' notes (most connected) · ' + t.edges + ' links')
    : (t.shown + ' notes · ' + t.edges + ' links');
}

function focusByQuery(el, ctx, q) {
  if (!q || !fg) return;
  var query = q.trim().toLowerCase();
  if (!query) return;
  // Match by path substring, then by basename label.
  var match = null;
  for (var id in nodeIndex) {
    if (id.toLowerCase().indexOf(query) !== -1) { match = id; break; }
  }
  if (!match) {
    for (var label in labelIndex) {
      if (label.toLowerCase().indexOf(query) !== -1) { match = labelIndex[label]; break; }
    }
  }
  if (match) { fg.highlight(match); loadNote(el, ctx, match); }
}

function resolveLink(target) {
  // [[path]] may be a full vault path (matches a node id) or a bare name
  // (matches a node basename). Strip any |alias and #heading.
  var t = String(target).split('|')[0].split('#')[0].trim();
  if (nodeIndex[t]) return t;
  if (nodeIndex[t + '.md']) return t + '.md';
  var base = t.replace(/\.md$/, '').split('/').pop();
  if (labelIndex[base] != null) return labelIndex[base];
  return null;
}

function loadNote(el, ctx, id) {
  var panel = el.querySelector('#graphNotePanel');
  if (!panel) return;
  panel.innerHTML = '<div class="skel skel--line" aria-hidden="true"></div>'
    + '<div class="skel skel--line" aria-hidden="true"></div>'
    + '<div class="skel skel--line" aria-hidden="true"></div>';
  ctx.fetchJson('/dashboard/api/note?path=' + encodeURIComponent(id))
    .then(function (note) { renderNote(el, ctx, note); })
    .catch(function () {
      panel.innerHTML = '<div class="state-error" role="alert">Failed to load note.</div>';
    });
}

function renderNote(el, ctx, note) {
  var panel = el.querySelector('#graphNotePanel');
  if (!panel) return;
  var esc = ctx.esc, escAttr = ctx.escAttr;
  var fm = note.frontmatter || {};

  var chips = [];
  if (fm.category) chips.push('<span class="badge badge--muted">' + esc(String(fm.category)) + '</span>');
  if (fm.temperature) chips.push('<span class="badge badge--info">' + esc(String(fm.temperature)) + '</span>');
  var tags = Array.isArray(fm.tags) ? fm.tags : [];
  tags.forEach(function (tg) { chips.push('<span class="badge badge--muted">' + esc(String(tg)) + '</span>'); });

  var body = stripFrontmatter(note.content || '');
  var rendered = renderMarkdownLite(body, esc, escAttr);

  panel.innerHTML =
    '<div class="graph-note-head">'
      + '<div class="graph-note-title">' + esc(note.title || note.path) + '</div>'
      + '<div class="card-sub mono">' + esc(note.path) + '</div>'
      + (chips.length ? '<div class="graph-note-chips">' + chips.join(' ') + '</div>' : '')
    + '</div>'
    + '<div class="graph-note-body">' + rendered + '</div>';

  // Wire [[wikilink]] clicks to focus + load that node.
  var links = panel.querySelectorAll('[data-wikilink]');
  for (var i = 0; i < links.length; i++) {
    (function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var resolved = resolveLink(a.getAttribute('data-wikilink'));
        if (resolved) { if (fg) fg.highlight(resolved); loadNote(el, ctx, resolved); }
      });
    })(links[i]);
  }
}

function stripFrontmatter(content) {
  return content.replace(/^---[\s\S]*?---\s*/, '');
}

/**
 * Minimal, dependency-free markdown: escape everything, then re-introduce
 * headings, [[wikilinks]] as clickable spans, and `code` spans. Intentionally
 * not a full parser — no remote markdown dep (ARCHITECTURE.md §7).
 */
function renderMarkdownLite(md, esc, escAttr) {
  var lines = md.split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push('<div class="md-h md-h' + h[1].length + '">' + inline(h[2], esc, escAttr) + '</div>');
    } else if (line.trim() === '') {
      out.push('<div class="md-sp"></div>');
    } else {
      out.push('<div class="md-p">' + inline(line, esc, escAttr) + '</div>');
    }
  }
  return out.join('');
}

function inline(text, esc, escAttr) {
  // Tokenize [[wikilinks]] before escaping so we can wrap them.
  var parts = [];
  var re = /\[\[([^\]]+)\]\]/g;
  var last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(escCode(text.slice(last, m.index), esc));
    var raw = m[1];
    var disp = raw.split('|')[1] || raw.split('|')[0];
    disp = disp.split('#')[0];
    var base = disp.replace(/\.md$/, '').split('/').pop();
    parts.push('<a href="#" class="md-link" data-wikilink="' + escAttr(raw) + '">' + esc(base) + '</a>');
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(escCode(text.slice(last), esc));
  return parts.join('');
}

function escCode(text, esc) {
  // Render `inline code` spans; escape the rest.
  return text.replace(/`([^`]+)`|([^`]+)/g, function (_all, code, plain) {
    if (code != null) return '<code>' + esc(code) + '</code>';
    return esc(plain);
  });
}
