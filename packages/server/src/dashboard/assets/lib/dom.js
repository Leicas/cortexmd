// dom.js — shared DOM + escaping helpers (ES module, no build).
// Escaping uses the same detached-DOM semantics as the legacy dashboard.

/** Get an element by id. */
export function $(id) { return document.getElementById(id); }

/** HTML-escape a string via a detached node (matches legacy `esc`). */
export function esc(s) {
  var d = document.createElement('span');
  d.textContent = s || '';
  return d.innerHTML;
}

/** Escape for use inside a double/single-quoted attribute (matches legacy `escAttr`). */
export function escAttr(s) {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Set textContent on an element by id (no-op if missing). */
export function setText(id, text) {
  var el = $(id);
  if (el) el.textContent = text;
}

/** Thin add-listener helper. */
export function on(el, evt, fn) {
  if (el) el.addEventListener(evt, fn);
}
