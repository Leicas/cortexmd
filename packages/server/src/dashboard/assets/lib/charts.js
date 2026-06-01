// charts.js — SVG chart helpers (ES module, no build). Pure SVG, no chart lib.
// viewBox stays 0 0 600 140; SVGs use preserveAspectRatio="none" so all strokes
// set vector-effect="non-scaling-stroke" to avoid distortion. See REVAMP.md §3.
//
// Public API (consumed by tab modules + components):
//   drawChart(svgId, points, color)        luminous area sparkline   [{y}]
//   drawBars(svgId, values, color, opts?)   vertical mini-histogram   number[]
//   drawGauge(svgId, value01, opts?)        bounded 0–1 arc gauge
//   drawMulti(svgId, series, opts?)         overlaid sparklines       [{points,color}]

var W = 600, H = 140;

/** Resolve a CSS custom-property reference like "var(--ok)" to a usable color. */
function resolveColor(c) {
  if (typeof c !== 'string') return c;
  var m = c.match(/^var\((--[\w-]+)\)$/);
  if (!m) return c;
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
    return v || c;
  } catch (_e) { return c; }
}

/** Pick a status color from a 0–1 value via good/warn cutoffs (higher = better). */
function statusColor(v01, good, warn) {
  if (v01 >= (good == null ? 0.8 : good)) return 'var(--ok)';
  if (v01 >= (warn == null ? 0.5 : warn)) return 'var(--warn)';
  return 'var(--err)';
}

/** 3a. Draw a luminous area sparkline into an <svg> by id. `points` = [{y}]. */
export function drawChart(svgId, points, color) {
  var svg = document.getElementById(svgId);
  if (!svg || !points || points.length < 2) { if (svg) svg.innerHTML = ''; return; }
  var w = W, h = H, pad = 4;
  var ys = points.map(function (p) { return p.y; });
  var max = Math.max.apply(null, [1].concat(ys));
  var step = w / (points.length - 1);
  var xy = points.map(function (p, i) { return [i * step, h - pad - (p.y / max) * (h - 2 * pad)]; });
  var line = xy.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
  var area = line + ' ' + w.toFixed(1) + ',' + h + ' 0,' + h;
  var gid = svgId + '-g';
  var last = xy[xy.length - 1];
  svg.innerHTML =
    '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="' + color + '" stop-opacity=".28"/>' +
    '<stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
    '<line x1="0" y1="' + (h * 0.5) + '" x2="' + w + '" y2="' + (h * 0.5) + '" stroke="rgba(255,255,255,.05)"/>' +
    '<polygon points="' + area + '" fill="url(#' + gid + ')"/>' +
    '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" ' +
    'vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3" fill="' + color + '"/>';
}

/** 3b. Vertical mini-histogram. `values` = number[]. opts: {median:boolean}. */
export function drawBars(svgId, values, color, opts) {
  var svg = document.getElementById(svgId);
  if (!svg || !values || !values.length) { if (svg) svg.innerHTML = ''; return; }
  opts = opts || {};
  var w = W, h = H, pad = 4;
  var max = Math.max.apply(null, [1].concat(values));
  var n = values.length;
  var slot = w / n, gap = Math.min(2, slot * 0.2), bw = Math.max(1, slot - gap);
  var gid = svgId + '-bg';
  var bars = values.map(function (v, i) {
    var bh = (v / max) * (h - 2 * pad);
    var x = i * slot + gap / 2;
    var y = h - pad - bh;
    var r = Math.min(2, bw / 2);
    return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) +
      '" height="' + Math.max(0, bh).toFixed(1) + '" rx="' + r + '" fill="url(#' + gid + ')"/>';
  }).join('');
  var medianLine = '';
  if (opts.median) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];
    var my = h - pad - (med / max) * (h - 2 * pad);
    medianLine = '<line x1="0" y1="' + my.toFixed(1) + '" x2="' + w + '" y2="' + my.toFixed(1) +
      '" stroke="var(--text-dim)" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>';
  }
  svg.innerHTML =
    '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="' + color + '" stop-opacity=".95"/>' +
    '<stop offset="1" stop-color="' + color + '" stop-opacity=".45"/></linearGradient></defs>' +
    bars + medianLine;
}

/** 3c. Bounded 0–1 arc gauge. opts: {label, good, warn, color}. Color from threshold map. */
export function drawGauge(svgId, value01, opts) {
  var svg = document.getElementById(svgId);
  if (!svg) return;
  opts = opts || {};
  var v = Math.max(0, Math.min(1, value01 || 0));
  var cx = W / 2, cy = H * 0.92, R = 58;
  var start = 135, sweep = 270;                  // 270° arc, bottom gap
  var col = opts.color || statusColor(v, opts.good, opts.warn);
  function pt(angDeg) {
    var a = (angDeg) * Math.PI / 180;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  }
  function arc(fromDeg, toDeg) {
    var p0 = pt(fromDeg), p1 = pt(toDeg);
    var large = (toDeg - fromDeg) > 180 ? 1 : 0;
    return 'M ' + p0[0].toFixed(1) + ' ' + p0[1].toFixed(1) +
      ' A ' + R + ' ' + R + ' 0 ' + large + ' 1 ' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1);
  }
  var track = arc(start, start + sweep);
  var valArc = v > 0 ? arc(start, start + sweep * v) : '';
  var label = opts.label != null ? String(opts.label) : Math.round(v * 100) + '';
  svg.innerHTML =
    '<path d="' + track + '" fill="none" stroke="var(--line-faint)" stroke-width="12" ' +
    'stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
    (valArc ? '<path d="' + valArc + '" fill="none" stroke="' + col + '" stroke-width="12" ' +
      'stroke-linecap="round" vector-effect="non-scaling-stroke"/>' : '') +
    '<text x="' + cx + '" y="' + (cy - 6) + '" text-anchor="middle" ' +
    'font-family="var(--font-sans)" font-size="34" font-weight="700" fill="' + col + '">' + label + '</text>' +
    (opts.sub ? '<text x="' + cx + '" y="' + (cy + 18) + '" text-anchor="middle" ' +
      'font-family="var(--mono)" font-size="13" fill="var(--text-dim)">' + opts.sub + '</text>' : '');
}

/** 3d. Overlaid sparklines. `series` = [{points:[{y}], color}]. opts: {normalize}. */
export function drawMulti(svgId, series, opts) {
  var svg = document.getElementById(svgId);
  if (!svg || !series || !series.length) { if (svg) svg.innerHTML = ''; return; }
  opts = opts || {};
  var w = W, h = H, pad = 6;
  var globalMax = 1;
  if (!opts.normalize) {
    series.forEach(function (s) {
      (s.points || []).forEach(function (p) { if (p.y > globalMax) globalMax = p.y; });
    });
  }
  var grid = '<line x1="0" y1="' + (h * 0.5) + '" x2="' + w + '" y2="' + (h * 0.5) +
    '" stroke="rgba(255,255,255,.05)"/>';
  var paths = series.map(function (s) {
    var pts = s.points || [];
    if (pts.length < 2) return '';
    var max = opts.normalize ? Math.max.apply(null, [1].concat(pts.map(function (p) { return p.y; }))) : globalMax;
    var step = w / (pts.length - 1);
    var xy = pts.map(function (p, i) { return [i * step, h - pad - (p.y / max) * (h - 2 * pad)]; });
    var line = xy.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var last = xy[xy.length - 1];
    return '<polyline points="' + line + '" fill="none" stroke="' + s.color + '" stroke-width="1.5" ' +
      'vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.5" fill="' + s.color + '"/>';
  }).join('');
  svg.innerHTML = grid + paths;
}

// Internal export so other helpers (and tests, if any) can reuse the resolver.
export { resolveColor };
