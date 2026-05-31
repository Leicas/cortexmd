// charts.js — SVG chart helpers (ES module, no build). `drawChart` is the
// sparkline extracted verbatim from the legacy dashboard. Stacked-area and
// gauge helpers used by vault/intelligence are inlined in those tab modules
// today; they can move here as those tabs are migrated.

/** Draw a filled sparkline into an <svg> by id. `points` = [{y}], `color` = css color. */
export function drawChart(svgId, points, color) {
  var svg = document.getElementById(svgId);
  if (!svg || points.length < 2) {
    if (svg) svg.innerHTML = '';
    return;
  }
  var w = 600, h = 140, pad = 2;
  var vals = points.map(function (p) { return p.y; });
  var max = Math.max.apply(null, vals.concat([1]));
  var step = w / (points.length - 1);

  var pts = points.map(function (p, i) {
    var x = i * step;
    var y = h - pad - (p.y / max) * (h - 2 * pad);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });

  var linePoints = pts.join(' ');
  var areaPoints = linePoints + ' ' + ((points.length - 1) * step).toFixed(1) + ',' + h + ' 0,' + h;

  svg.innerHTML = '<polygon points="' + areaPoints + '" fill="' + color + '" opacity="0.1"/>'
    + '<polyline points="' + linePoints + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
}
