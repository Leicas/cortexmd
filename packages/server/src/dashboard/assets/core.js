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
  $, esc, escAttr, on, fmt, charts,
  toast, postAction, fetchJson, copyLogLine, setLive, switchTab,
};

// ── window.cortex action namespace ──────────────────────────────────────────
// Server-rendered HTML strings reference these globals (ES modules don't expose
// globals automatically). Core seeds the universal ones; tab modules add their
// own action callbacks here in their init().
window.cortex = window.cortex || {};
window.cortex.postAction = postAction;
window.cortex.copyLogLine = copyLogLine;
window.cortex.toast = toast;
window.cortex.switchTab = switchTab;   // KPI deep-links / status pills call this

// ── Tab switching ───────────────────────────────────────────────────────────

function switchTab(id) {
  if (!tabs.has(id) && !$('tab-' + id)) return;
  activeTab = id;
  document.querySelectorAll('.tab-btn').forEach(function (b) {
    var on = b.getAttribute('data-tab') === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.setAttribute('tabindex', on ? '0' : '-1');
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
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
      data = JSON.parse(ev.data);
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

/** Boot the dashboard: wire tab bar, start clock, connect SSE, activate default tab. */
export function boot() {
  wireTabBar();
  startClock();
  on($('refreshBtn'), 'click', reconnect);
  connectSse();
  switchTab(activeTab);
}
