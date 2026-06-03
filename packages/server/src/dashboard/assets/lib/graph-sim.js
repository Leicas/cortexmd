// graph-sim.js — dependency-free force-directed graph on <canvas> (ES module,
// no build). A small Fruchterman-Reingold spring-electrical layout with
// pan/zoom, node drag, hit-testing and click selection. O(n^2) per tick, which
// is fine for the few-hundred-node subgraph the /dashboard/api/graph route
// returns (it caps by connectivity). No deps; matches the no-bundler house
// style. See ARCHITECTURE.md §7.
//
//   var fg = ForceGraph(canvas, { nodes, edges });
//   fg.onNodeClick(function (node) { ... });
//   fg.setData({ nodes, edges });   fg.zoomToFit();   fg.highlight(id);
//   fg.destroy();

/** Resolve "var(--x)" → concrete color (copied from charts.js). */
function resolveColor(c) {
  if (typeof c !== 'string') return c;
  var m = c.match(/^var\((--[\w-]+)\)$/);
  if (!m) return c;
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
    return v || c;
  } catch (_e) { return c; }
}

// Group → palette. Unknown groups hash onto the palette deterministically.
var PALETTE_VARS = ['--brand', '--ok', '--warn', '--err', '--info', '--blue', '--green', '--purple', '--accent'];
function buildPalette() {
  var out = [];
  for (var i = 0; i < PALETTE_VARS.length; i++) {
    var col = resolveColor('var(' + PALETTE_VARS[i] + ')');
    if (col && col.charAt(0) === '#') out.push(col);
    else if (col && col.indexOf('rgb') === 0) out.push(col);
  }
  if (!out.length) out = ['#6ea8fe', '#5ad19a', '#e6b450', '#e0607e', '#9b8cff'];
  return out;
}
function hashStr(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

export function ForceGraph(canvas, data) {
  var ctx = canvas.getContext('2d');
  var palette = buildPalette();
  var groupColor = {};
  function colorFor(group) {
    var g = group || 'general';
    if (!groupColor[g]) groupColor[g] = palette[hashStr(g) % palette.length];
    return groupColor[g];
  }

  var nodes = [], edges = [], byId = {};
  var scale = 1, offsetX = 0, offsetY = 0;
  var alpha = 1, raf = null, running = false;
  var hovered = null, selected = null, dragNode = null, dragging = false;
  var panning = false, lastX = 0, lastY = 0, downX = 0, downY = 0, moved = false;
  var clickCb = null;
  var neighbors = {}; // id -> set of neighbor ids (for highlight)

  function cssSize() {
    var r = canvas.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    var s = cssSize();
    canvas.width = Math.round(s.w * dpr);
    canvas.height = Math.round(s.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function setData(d) {
    nodes = (d.nodes || []).map(function (n) {
      return {
        id: n.id, label: n.label || n.id, group: n.group || 'general',
        deg: n.deg || 0, inDeg: n.inDeg || 0, outDeg: n.outDeg || 0,
        x: 0, y: 0, vx: 0, vy: 0, fixed: false,
      };
    });
    byId = {};
    neighbors = {};
    var s = cssSize();
    nodes.forEach(function (n, i) {
      // Seed on a spiral so the layout unfolds deterministically. A wider
      // initial radius keeps the sim from starting in a tight ball it can't
      // escape (attraction + gravity otherwise win before it spreads).
      var ang = i * 2.399963229; // golden angle
      var rad = 16 * Math.sqrt(i + 1);
      n.x = s.w / 2 + rad * Math.cos(ang);
      n.y = s.h / 2 + rad * Math.sin(ang);
      byId[n.id] = n;
      neighbors[n.id] = {};
    });
    edges = (d.edges || []).filter(function (e) { return byId[e.source] && byId[e.target] && e.source !== e.target; });
    edges.forEach(function (e) {
      neighbors[e.source][e.target] = 1;
      neighbors[e.target][e.source] = 1;
    });
    alpha = 1;
    start();
  }

  function radiusOf(n) { return 3 + Math.min(12, Math.sqrt(n.deg) * 1.7); }

  function tick() {
    var n = nodes.length;
    if (!n) return;
    var s = cssSize();
    var area = s.w * s.h;
    var k = Math.max(28, Math.sqrt(area / n) * 1.25); // ideal edge length (longer → more spread)
    var k2 = k * k;
    var cx = s.w / 2, cy = s.h / 2;

    for (var i = 0; i < n; i++) { nodes[i]._dx = 0; nodes[i]._dy = 0; }

    // Repulsion (all pairs).
    for (var a = 0; a < n; a++) {
      var na = nodes[a];
      for (var b = a + 1; b < n; b++) {
        var nb = nodes[b];
        var dx = na.x - nb.x, dy = na.y - nb.y;
        var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        var rep = k2 / dist;
        var ux = dx / dist, uy = dy / dist;
        na._dx += ux * rep; na._dy += uy * rep;
        nb._dx -= ux * rep; nb._dy -= uy * rep;
      }
    }
    // Attraction along edges.
    for (var e = 0; e < edges.length; e++) {
      var su = byId[edges[e].source], tv = byId[edges[e].target];
      var ex = su.x - tv.x, ey = su.y - tv.y;
      var ed = Math.sqrt(ex * ex + ey * ey) || 0.01;
      var att = (ed * ed) / k;
      var fx = (ex / ed) * att, fy = (ey / ed) * att;
      su._dx -= fx; su._dy -= fy;
      tv._dx += fx; tv._dy += fy;
    }
    // Gravity to center (keeps disconnected nodes on screen) + integrate.
    var maxStep = 8 + 40 * alpha;
    for (var c = 0; c < n; c++) {
      var nd = nodes[c];
      nd._dx += (cx - nd.x) * 0.006;
      nd._dy += (cy - nd.y) * 0.006;
      if (nd === dragNode && dragging) continue;
      var dlen = Math.sqrt(nd._dx * nd._dx + nd._dy * nd._dy) || 0.01;
      var step = Math.min(dlen, maxStep) * alpha;
      nd.x += (nd._dx / dlen) * step;
      nd.y += (nd._dy / dlen) * step;
    }
    alpha = Math.max(0, alpha - 0.012);
  }

  function toScreen(n) { return { x: n.x * scale + offsetX, y: n.y * scale + offsetY }; }

  function draw() {
    var s = cssSize();
    ctx.clearRect(0, 0, s.w, s.h);
    var hl = hovered || selected;
    var hlNbrs = hl ? neighbors[hl.id] : null;

    // Edges.
    ctx.lineWidth = 1;
    for (var e = 0; e < edges.length; e++) {
      var su = byId[edges[e].source], tv = byId[edges[e].target];
      var p1 = toScreen(su), p2 = toScreen(tv);
      var active = hl && (su === hl || tv === hl);
      ctx.strokeStyle = active ? 'rgba(150,180,255,0.65)' : 'rgba(140,150,170,0.12)';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    // Nodes.
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var p = toScreen(nd);
      var r = radiusOf(nd) * Math.sqrt(scale);
      var dim = hl && nd !== hl && !(hlNbrs && hlNbrs[nd.id]);
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(nd.group);
      ctx.fill();
      if (nd === selected) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Labels: hovered/selected + its neighbors, or well-connected nodes when zoomed in.
      var showLabel = nd === hl || (hlNbrs && hlNbrs[nd.id]) || (scale > 1.4 && nd.deg >= 3) || (!hl && nd.deg >= 8);
      if (showLabel) {
        ctx.globalAlpha = dim ? 0.4 : 1;
        ctx.fillStyle = 'rgba(225,230,240,0.92)';
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(nd.label, p.x + r + 3, p.y + 3);
        ctx.globalAlpha = 1;
      }
    }
  }

  function loop() {
    if (alpha > 0.005) tick();
    draw();
    if (alpha > 0.005 || dragging) {
      raf = window.requestAnimationFrame(loop);
    } else {
      running = false;
      raf = null;
    }
  }
  function start() {
    if (running) return;
    running = true;
    raf = window.requestAnimationFrame(loop);
  }
  function reheat(v) { alpha = Math.max(alpha, v == null ? 0.4 : v); start(); }

  function zoomToFit() {
    if (!nodes.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
    });
    var s = cssSize();
    var gw = Math.max(1, maxX - minX), gh = Math.max(1, maxY - minY);
    scale = Math.min(2.5, Math.max(0.15, Math.min(s.w / (gw + 80), s.h / (gh + 80))));
    offsetX = s.w / 2 - ((minX + maxX) / 2) * scale;
    offsetY = s.h / 2 - ((minY + maxY) / 2) * scale;
    draw();
  }

  // ── Hit testing + pointer interaction ──────────────────────────────────────
  function pick(mx, my) {
    var best = null, bestD = 0;
    for (var i = 0; i < nodes.length; i++) {
      var p = toScreen(nodes[i]);
      var r = radiusOf(nodes[i]) * Math.sqrt(scale) + 4;
      var dx = mx - p.x, dy = my - p.y;
      var d2 = dx * dx + dy * dy;
      if (d2 <= r * r && (best === null || d2 < bestD)) { best = nodes[i]; bestD = d2; }
    }
    return best;
  }
  function evtPos(ev) {
    var r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  function onDown(ev) {
    var p = evtPos(ev);
    downX = p.x; downY = p.y; lastX = p.x; lastY = p.y; moved = false;
    var hit = pick(p.x, p.y);
    if (hit) { dragNode = hit; dragging = true; hit.fixed = true; }
    else { panning = true; }
    canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId);
  }
  function onMove(ev) {
    var p = evtPos(ev);
    if (dragging && dragNode) {
      dragNode.x += (p.x - lastX) / scale;
      dragNode.y += (p.y - lastY) / scale;
      lastX = p.x; lastY = p.y; moved = true; reheat(0.15);
    } else if (panning) {
      offsetX += p.x - lastX; offsetY += p.y - lastY;
      lastX = p.x; lastY = p.y; moved = true; draw();
    } else {
      var h = pick(p.x, p.y);
      if (h !== hovered) { hovered = h; canvas.style.cursor = h ? 'pointer' : 'grab'; draw(); }
    }
  }
  function onUp(ev) {
    var p = evtPos(ev);
    var isClick = Math.abs(p.x - downX) < 4 && Math.abs(p.y - downY) < 4 && !moved;
    if (isClick) {
      var hit = pick(p.x, p.y);
      selected = hit || null;
      if (hit && clickCb) clickCb({ id: hit.id, label: hit.label, group: hit.group, deg: hit.deg });
      draw();
    }
    if (dragNode) dragNode.fixed = false;
    dragNode = null; dragging = false; panning = false;
  }
  function onWheel(ev) {
    ev.preventDefault();
    var p = evtPos(ev);
    var factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    var ns = Math.min(6, Math.max(0.08, scale * factor));
    // Zoom around cursor.
    offsetX = p.x - (p.x - offsetX) * (ns / scale);
    offsetY = p.y - (p.y - offsetY) * (ns / scale);
    scale = ns;
    draw();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  var ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(canvas); else window.addEventListener('resize', resize);

  resize();
  if (data) setData(data);
  // Fit once the layout has had a moment to unfold.
  window.setTimeout(zoomToFit, 600);

  return {
    setData: function (d) { selected = null; hovered = null; setData(d); window.setTimeout(zoomToFit, 600); },
    onNodeClick: function (cb) { clickCb = cb; },
    zoomToFit: zoomToFit,
    reheat: reheat,
    highlight: function (id) { selected = byId[id] || null; draw(); },
    getSelected: function () { return selected ? selected.id : null; },
    destroy: function () {
      if (raf) window.cancelAnimationFrame(raf);
      running = false;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
    },
  };
}
