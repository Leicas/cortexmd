// fmt.js — formatting utilities (ES module, no build). Extracted verbatim from
// the legacy dashboard client JS. NOTE: these are real .js files, so unicode
// escapes are single-backslash (—), unlike the legacy template literal.

export function fmt(n) { return n == null ? '—' : Number(n).toLocaleString(); }

export function fmtMs(ms) { return ms == null ? '—' : ms + ' ms'; }

export function fmtUptime(ms) {
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  var p = []; if (d) p.push(d + 'd'); p.push(h + 'h'); p.push(m + 'm'); return p.join(' ');
}

export function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtAgo(ts) {
  if (!ts) return '—';
  var timestamp = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  if (isNaN(timestamp)) return '—';
  var diff = Date.now() - timestamp;
  if (diff < 0) return 'just now';
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

export function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n) {
  if (!n) return '0';
  var units = ['B', 'KB', 'MB', 'GB'];
  var i = 0;
  var v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

export function latClass(ms) {
  if (ms < 100) return 'lat-green';
  if (ms < 500) return 'lat-yellow';
  return 'lat-red';
}

export function truncate(s, n) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
