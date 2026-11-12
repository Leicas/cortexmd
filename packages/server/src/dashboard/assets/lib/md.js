// md.js — tiny, dependency-free markdown renderer for note bodies (ES module).
// Escapes everything first, then re-introduces headings, list items, block
// quotes, fenced code, **bold**, `code` and [[wikilinks]]. Wikilinks become
// in-dashboard deep links (`#memories/<path>`), never raw HTML from the note.

import { esc, escAttr } from './dom.js';

function inline(text) {
  var out = '', last = 0, m;
  var re = /\[\[([^\]]+)\]\]/g;
  while ((m = re.exec(text)) !== null) {
    out += plain(text.slice(last, m.index));
    var raw = m[1];
    var target = raw.split('|')[0].split('#')[0].trim();
    var disp = (raw.split('|')[1] || target).replace(/\.md$/, '');
    var path = /\.md$/.test(target) ? target : target + '.md';
    out += '<a class="md-link" href="#memories/' + escAttr(path.split('/').map(encodeURIComponent).join('/')) +
      '" data-note-path="' + escAttr(path) + '">' + esc(disp.split('/').pop()) + '</a>';
    last = re.lastIndex;
  }
  return out + plain(text.slice(last));
}

function plain(text) {
  return text.replace(/`([^`]+)`|([^`]+)/g, function (_a, code, rest) {
    if (code != null) return '<code>' + esc(code) + '</code>';
    return esc(rest).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  });
}

/** Render a markdown body (no frontmatter) to safe HTML. */
export function renderMarkdown(md) {
  var lines = String(md || '').split('\n');
  var out = [], inCode = false, code = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^```/.test(line)) {
      if (inCode) { out.push('<pre class="md-pre"><code>' + esc(code.join('\n')) + '</code></pre>'); code = []; }
      inCode = !inCode;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    var h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push('<div class="md-h md-h' + Math.min(h[1].length, 4) + '">' + inline(h[2]) + '</div>'); continue; }
    var li = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) { out.push('<div class="md-li">' + inline(li[1]) + '</div>'); continue; }
    var bq = /^>\s?(.*)$/.exec(line);
    if (bq) { out.push('<div class="md-bq">' + inline(bq[1]) + '</div>'); continue; }
    if (line.trim() === '') { out.push('<div class="md-sp"></div>'); continue; }
    out.push('<div class="md-p">' + inline(line) + '</div>');
  }
  if (inCode) out.push('<pre class="md-pre"><code>' + esc(code.join('\n')) + '</code></pre>');
  return out.join('');
}
