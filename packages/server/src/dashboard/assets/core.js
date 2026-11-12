// core.js — dashboard client core (ES module, no build). Owns everything
// cross-tab: latest SSE payload, single EventSource, tab switching, clock,
// toast, postAction, fetchJson, and the `window.cortex` action namespace that
// server-rendered HTML strings call. See ARCHITECTURE.md §3 + REVAMP.md §6/§8.
//
// Payload shape (the `DashboardPayload`): documented in
// src/dashboard/payload.types.ts — the server `model/payload.ts` return type is
// the authoritative contract. Tabs read data only from `ctx.data`.

import { $, esc, escAttr, on } from './lib/dom.js';
import * as fmt from './lib/fmt.js';
import * as charts from './lib/charts.js';

/** @typedef {{ id:string, init?:(el:HTMLElement, ctx:Ctx)=>void, refresh?:(el:HTMLElement, ctx:Ctx)=>void }} TabModule */
/** @typedef {typeof ctx} Ctx */

const tabs = new Map();      // id -> TabModule
const inited = new Set();    // tabs whose init() has run
let activeTab = 'overview';
let data = {};               // latest SSE payload
let lastUpdateTs = 0;        // wall-clock of last SSE message (for "updated Ns ago")
let es = null;               // the single EventSource
let health = null;           // latest GET /health JSON (polled; no auth needed)
const HEALTH_POLL_MS = 30000;

/** Register a tab module (called from app.js for each tab). */
export function registerTab(mod) { tabs.set(mod.id, mod); }

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Transient toast notification (matches legacy `showToast`). */
export function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  var c = $('toastContainer');
  if (c) c.appendChild(el);
  setTimeout(function () { el.remove(); }, 3000);
}

// ── Auth + CSRF plumbing ────────────────────────────────────────────────────

function metaContent(name) {
  var m = document.querySelector('meta[name="' + name + '"]');
  return m ? m.getAttribute('content') || '' : '';
}
var CSRF_TOKEN = metaContent('csrf-token');
var OBSIDIAN_VAULT = metaContent('obsidian-vault');

/** Session expired / not logged in → go to the login form (once). */
var redirecting = false;
export function redirectToLogin() {
  if (redirecting) return;
  redirecting = true;
  toast('Session expired — redirecting to sign in…', 'error');
  setTimeout(function () { window.location.assign('/login'); }, 600);
}

// Every same-origin state-changing fetch carries the CSRF token (security.ts).
// Patched once here so all tab modules (old and new) are covered without
// touching each call site. A 401 on any same-origin call means the session
// expired → redirect to /login.
(function patchFetch() {
  var orig = window.fetch.bind(window);
  window.fetch = function (input, init) {
    init = init || {};
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var sameOrigin = url.charAt(0) === '/' || url.indexOf(window.location.origin) === 0;
    if (sameOrigin && method !== 'GET' && method !== 'HEAD' && CSRF_TOKEN) {
      var h = new Headers(init.headers || (typeof input !== 'string' && input && input.headers) || {});
      if (!h.has('X-CSRF-Token')) h.set('X-CSRF-Token', CSRF_TOKEN);
      init = Object.assign({}, init, { headers: h });
    }
    return orig(input, init).then(function (r) {
      if (r.status === 401 && sameOrigin) redirectToLogin();
      return r;
    });
  };
})();

/** POST JSON + toast on {ok}/{error} (matches legacy `window.postAction`). */
export function postAction(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(function (r) { return r.json().catch(function () { return { error: 'HTTP ' + r.status }; }); })
    .then(function (d) {
      if (d.ok) toast('Action completed', 'success');
      else toast(d.error || 'Unknown error', 'error');
      return d;
    })
    .catch(function (e) { toast('Request failed: ' + e.message, 'error'); });
}

/**
 * Fetch + parse JSON. 401 → redirect to /login (and reject). Non-2xx with a
 * JSON `{error}` body rejects with that message so callers can show it.
 */
export function fetchJson(url, opts) {
  return fetch(url, opts).then(function (r) {
    if (r.status === 401) { redirectToLogin(); throw new Error('Not signed in'); }
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
      return d;
    });
  });
}

/** POST JSON via fetchJson (CSRF header added by the fetch patch). */
export function postJson(url, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

/** `obsidian://open` URL for a vault-relative note path ('' when unknown vault). */
export function obsidianUrl(path) {
  if (!OBSIDIAN_VAULT || !path) return '';
  return 'obsidian://open?vault=' + encodeURIComponent(OBSIDIAN_VAULT) +
    '&file=' + encodeURIComponent(String(path).replace(/\.md$/, ''));
}

/** Small "Open in Obsidian" anchor for a note path (empty string when unavailable). */
export function obsidianLink(path, label) {
  var u = obsidianUrl(path);
  if (!u) return '';
  return '<a class="obs-link" href="' + escAttr(u) + '" title="Open ' + escAttr(path) + ' in Obsidian">' +
    esc(label || 'Open in Obsidian') + '<span class="sr-only"> (' + esc(path) + ')</span></a>';
}

/** Copy a log line to clipboard (matches legacy `window.copyLogLine`). */
export function copyLogLine(el) {
  var text = el.getAttribute('data-full') || el.textContent;
  navigator.clipboard.writeText(text).then(function () {
    el.classList.add('copied');
    toast('Copied to clipboard', 'success');
    setTimeout(function () { el.classList.remove('copied'); }, 1000);
  }).catch(function () { toast('Copy failed', 'error'); });
}

/**
 * Set an element's text and, if it changed, pulse the `.flash` highlight (the
 * "what just changed?" cue on a live console). Skips the flash on first paint.
 * Tabs can call ctx.setLive(id, text) instead of `$(id).textContent = ...`.
 */
export function setLive(id, text) {
  var el = typeof id === 'string' ? $(id) : id;
  if (!el) return;
  var next = text == null ? '' : String(text);
  if (el.textContent === next) return;
  var hadPrev = el.dataset.seeded === '1';
  el.textContent = next;
  el.dataset.seeded = '1';
  if (hadPrev) {
    el.classList.remove('flash');
    // force reflow so re-adding restarts the animation
    void el.offsetWidth;
    el.classList.add('flash');
    el.addEventListener('animationend', function once() {
      el.classList.remove('flash');
      el.removeEventListener('animationend', once);
    });
  }
}

/** Context passed to every tab init/refresh. `data` is a live payload getter. */
export const ctx = {
  get data() { return data; },
  /** Latest GET /health JSON (null until the first poll succeeds). */
  get health() { return health; },
  $, esc, escAttr, on, fmt, charts,
  toast, postAction, fetchJson, postJson, copyLogLine, setLive, switchTab,
  obsidianUrl, obsidianLink, setRoute,
  /** Sub-route of the active tab from the URL hash (`#tab/<rest>` → rest). */
  get route() { return currentRest; },
};

// ── window.cortex action namespace ──────────────────────────────────────────
// Server-rendered HTML strings reference these globals (ES modules don't expose
// globals automatically). Core seeds the universal ones; tab modules add their
// own action callbacks here in their init().
window.cortex = window.cortex || {};
window.cortex.postAction = postAction;
window.cortex.copyLogLine = copyLogLine;
window.cortex.toast = toast;
window.cortex.switchTab = function (id) { switchTab(id); };   // KPI deep-links / status pills call this

// ── CSP-safe action delegation ──────────────────────────────────────────────
// Inline `onclick` handlers are blocked by the CSP (script-src 'self'), so
// markup declares `data-cx-click="cortex.fn('a', true, this)"` and this single
// delegated listener parses the call (string / number / boolean / null / {} /
// `this` literals only — never eval) and invokes `window.cortex[fn]`.

export function parseCxCall(src) {
  var m = /^\s*(?:window\.)?cortex\.([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(src || '');
  if (!m) return null;
  var args = [], s = m[2], i = 0;
  function skip() { while (i < s.length && /[\s,]/.test(s[i])) i++; }
  skip();
  while (i < s.length) {
    var c = s[i];
    if (c === "'" || c === '"') {
      var q = c, out = ''; i++;
      while (i < s.length && s[i] !== q) {
        if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; } else { out += s[i++]; }
      }
      i++; args.push(out);
    } else if (s.slice(i, i + 4) === 'this') { args.push({ $this: true }); i += 4; }
    else if (s.slice(i, i + 4) === 'true') { args.push(true); i += 4; }
    else if (s.slice(i, i + 5) === 'false') { args.push(false); i += 5; }
    else if (s.slice(i, i + 4) === 'null') { args.push(null); i += 4; }
    else if (c === '{') {
      var depth = 0, j = i;
      for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}' && --depth === 0) break; }
      var lit = s.slice(i, j + 1); i = j + 1;
      try { args.push(JSON.parse(lit)); } catch (_e) { args.push({}); }
    } else {
      var n = /^-?\d+(\.\d+)?/.exec(s.slice(i));
      if (!n) return null;
      args.push(Number(n[0])); i += n[0].length;
    }
    skip();
  }
  return { fn: m[1], args: args };
}

function wireDelegation() {
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-cx-click]') : null;
    if (!el) return;
    var call = parseCxCall(el.getAttribute('data-cx-click'));
    if (!call || typeof window.cortex[call.fn] !== 'function') return;
    ev.preventDefault();
    var args = call.args.map(function (a) { return a && a.$this ? el : a; });
    window.cortex[call.fn].apply(null, args);
  });
}

// ── Tab switching + hash routing ────────────────────────────────────────────
// URL shape: `#<tab>` or `#<tab>/<rest>` (rest is tab-defined, e.g.
// `#memories/Memories/fact/x.md`, `#lab/eval`). Tabs that care implement
// `route(el, ctx, rest)`; switchTab keeps the hash in sync.

var currentRest = '';
var suppressHash = false;

function parseHash() {
  var raw = (window.location.hash || '').replace(/^#\/?/, '');
  var h;
  try { h = decodeURIComponent(raw); } catch (_e) { h = raw; }
  var slash = h.indexOf('/');
  return slash < 0 ? { tab: h, rest: '' } : { tab: h.slice(0, slash), rest: h.slice(slash + 1) };
}

function writeHash(tab, rest, replace) {
  var next = '#' + tab + (rest ? '/' + rest.split('/').map(encodeURIComponent).join('/') : '');
  if (window.location.hash === next) return;
  suppressHash = true;
  if (replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
  setTimeout(function () { suppressHash = false; }, 0);
}

/** Update the sub-route of the active tab (pushes a history entry unless `replace`). */
export function setRoute(rest, replace) {
  currentRest = rest || '';
  writeHash(activeTab, currentRest, replace);
}

function switchTab(id, opts) {
  if (!tabs.has(id) && !$('tab-' + id)) return;
  opts = opts || {};
  var changed = id !== activeTab;
  activeTab = id;
  if (opts.rest !== undefined) currentRest = opts.rest;
  else if (changed) currentRest = '';
  if (!opts.fromHash) writeHash(id, currentRest, !!opts.replace);
  document.querySelectorAll('.tab-btn').forEach(function (b) {
    var on = b.getAttribute('data-tab') === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.setAttribute('tabindex', on ? '0' : '-1');
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
    // Keep the active tab visible in the horizontally scrolling bar (phones).
    if (on && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  document.querySelectorAll('.tab-panel').forEach(function (p) {
    p.classList.toggle('active', p.id === 'tab-' + id);
  });
  var mod = tabs.get(id);
  var el = $('tab-' + id);
  if (mod && el && !inited.has(id)) { if (mod.init) mod.init(el, ctx); inited.add(id); }
  if (mod && el && mod.route) mod.route(el, ctx, currentRest);
  if (mod && el && mod.refresh) mod.refresh(el, ctx);
}

function onHashChange() {
  if (suppressHash) return;
  var r = parseHash();
  if (!r.tab || (!tabs.has(r.tab) && !$('tab-' + r.tab))) return;
  switchTab(r.tab, { rest: r.rest, fromHash: true });
}

function wireTabBar() {
  var btns = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  btns.forEach(function (b, i) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    // Roving-tabindex arrow-key navigation (WCAG tablist pattern).
    b.addEventListener('keydown', function (ev) {
      var next = -1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (i + 1) % btns.length;
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (i - 1 + btns.length) % btns.length;
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = btns.length - 1;
      else return;
      ev.preventDefault();
      var target = btns[next];
      switchTab(target.getAttribute('data-tab'));
      target.focus();
    });
  });
}

// ── Clock + freshness ────────────────────────────────────────────────────────

function startClock() {
  function tick() {
    var c = $('clock');
    if (c) c.textContent = new Date().toLocaleTimeString();
    var lu = $('lastUpdate');
    if (lu) lu.textContent = lastUpdateTs ? 'updated ' + agoShort(lastUpdateTs) : '—';
  }
  tick();
  setInterval(tick, 1000);
}

/** Compact "Ns ago" for the freshness indicator. */
function agoShort(ts) {
  var diff = Date.now() - ts;
  if (diff < 1500) return 'just now';
  if (diff < 60000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  return Math.floor(diff / 3600000) + 'h ago';
}

/** Mirror the flagship health grade into the header chip (visible everywhere). */
function updateHealthChip() {
  var chip = $('healthChip');
  if (!chip) return;
  var hs = data && data.healthScore;
  if (!hs || !hs.grade) { chip.textContent = '—'; chip.className = 'health-chip'; return; }
  var grade = String(hs.grade);
  var letter = grade.charAt(0).toLowerCase();
  chip.textContent = grade;
  chip.className = 'health-chip grade-' + (/[a-f]/.test(letter) ? letter : 'c');
  chip.setAttribute('aria-label', 'Vault health grade ' + grade);
}

// ── SSE — single EventSource feeding all tabs ───────────────────────────────

function connectSse() {
  es = new EventSource('/dashboard/events');
  es.onmessage = function (ev) {
    try {
      var msg = JSON.parse(ev.data);
      // Delta frames (sse.ts) carry only changed top-level sections; merge them
      // into the last full payload and drop the keys listed in `_removed`.
      if (msg && msg._delta) {
        var next = Object.assign({}, data);
        Object.keys(msg).forEach(function (k) { if (k !== '_delta' && k !== '_removed') next[k] = msg[k]; });
        (msg._removed || []).forEach(function (k) { delete next[k]; });
        data = next;
      } else {
        data = msg;
      }
      lastUpdateTs = Date.now();
      document.body.removeAttribute('data-sse');
      var up = $('uptime');
      if (up) up.textContent = fmt.fmtUptime(data.uptime);
      var lu = $('lastUpdate');
      if (lu) lu.textContent = 'updated just now';
      updateHealthChip();
      var mod = tabs.get(activeTab);
      var el = $('tab-' + activeTab);
      if (mod && el && mod.refresh) mod.refresh(el, ctx);
    } catch (err) { console.error('Dashboard parse error:', err); }
  };
  es.onerror = function () {
    document.body.setAttribute('data-sse', 'reconnecting');
    es.close();
    setTimeout(connectSse, 3000);
  };
}

/** Manual refresh: tear down + reconnect the single EventSource. */
function reconnect() {
  if (es) { try { es.close(); } catch (_e) { /* ignore */ } }
  document.body.setAttribute('data-sse', 'reconnecting');
  connectSse();
}

// ── /health polling (version · commit in the header, Server card on Overview) ─
// GET /health needs no auth and is cheap; it is polled every HEALTH_POLL_MS
// independently of the SSE payload so the header shows the running version
// even before the first SSE push (and keeps the last snapshot on failure).

function renderServerVersion(h) {
  var sv = $('serverVersion');
  if (!sv) return;
  var v = h && h.version ? 'v' + h.version : '';
  var c = h && typeof h.commit === 'string' && h.commit && h.commit !== 'unknown' ? h.commit.slice(0, 7) : '';
  sv.textContent = (v && c) ? v + ' · ' + c : (v || c || '—');
  sv.setAttribute('title', 'Server ' + (v || '?') + (c ? ' · commit ' + c : '') + ' (from /health)');
}

function pollHealth() {
  fetch('/health', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (h) {
      if (!h || typeof h !== 'object') return;
      health = h;
      renderServerVersion(h);
      var mod = tabs.get(activeTab);
      var el = $('tab-' + activeTab);
      if (mod && el && mod.refresh) mod.refresh(el, ctx);
    })
    .catch(function () { /* unreachable: keep the last snapshot */ });
}

/** Boot the dashboard: wire tab bar, start clock, connect SSE, poll /health, activate default tab. */
export function boot() {
  wireTabBar();
  wireDelegation();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('popstate', onHashChange);
  var initial = parseHash();
  if (initial.tab && (tabs.has(initial.tab) || $('tab-' + initial.tab))) {
    activeTab = initial.tab;
    currentRest = initial.rest;
  }
  startClock();
  on($('refreshBtn'), 'click', reconnect);
  connectSse();
  pollHealth();
  setInterval(pollHealth, HEALTH_POLL_MS);
  switchTab(activeTab, { rest: currentRest, replace: true });
}
