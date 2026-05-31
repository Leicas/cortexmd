// core.js — dashboard client core (ES module, no build). Owns everything
// cross-tab: latest SSE payload, single EventSource, tab switching, clock,
// toast, postAction, fetchJson, and the `window.cortex` action namespace that
// server-rendered HTML strings call. See ARCHITECTURE.md §3.
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

/** POST JSON + toast on {ok}/{error} (matches legacy `window.postAction`). */
export function postAction(url, body) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.ok) toast('Action completed', 'success');
      else toast(d.error || 'Unknown error', 'error');
    })
    .catch(function (e) { toast('Request failed: ' + e.message, 'error'); });
}

/** GET + parse JSON. */
export function fetchJson(url, opts) {
  return fetch(url, opts).then(function (r) { return r.json(); });
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

/** Context passed to every tab init/refresh. `data` is a live payload getter. */
export const ctx = {
  get data() { return data; },
  $, esc, escAttr, on, fmt, charts,
  toast, postAction, fetchJson, copyLogLine,
};

// ── window.cortex action namespace ──────────────────────────────────────────
// Server-rendered HTML strings reference these globals (ES modules don't expose
// globals automatically). Core seeds the universal ones; tab modules add their
// own action callbacks here in their init().
window.cortex = window.cortex || {};
window.cortex.postAction = postAction;
window.cortex.copyLogLine = copyLogLine;
window.cortex.toast = toast;

// ── Tab switching ───────────────────────────────────────────────────────────

function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('.tab-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === id);
  });
  document.querySelectorAll('.tab-panel').forEach(function (p) {
    p.classList.toggle('active', p.id === 'tab-' + id);
  });
  var mod = tabs.get(id);
  var el = $('tab-' + id);
  if (mod && el && !inited.has(id)) { if (mod.init) mod.init(el, ctx); inited.add(id); }
  if (mod && el && mod.refresh) mod.refresh(el, ctx);
}

function wireTabBar() {
  document.querySelectorAll('.tab-btn').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });
}

// ── Clock ───────────────────────────────────────────────────────────────────

function startClock() {
  function tick() {
    var el = $('clock');
    if (el) el.textContent = new Date().toLocaleTimeString();
  }
  tick();
  setInterval(tick, 1000);
}

// ── SSE — single EventSource feeding all tabs ───────────────────────────────

function connectSse() {
  var es = new EventSource('/dashboard/events');
  es.onmessage = function (ev) {
    try {
      data = JSON.parse(ev.data);
      document.body.removeAttribute('data-sse');
      var up = $('uptime');
      if (up) up.textContent = fmt.fmtUptime(data.uptime);
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

/** Boot the dashboard: wire tab bar, start clock, connect SSE, activate default tab. */
export function boot() {
  wireTabBar();
  startClock();
  connectSse();
  switchTab(activeTab);
}
