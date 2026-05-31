/**
 * `renderPage()` — the dashboard HTML shell. Emits doctype + <head> (linking
 * the external stylesheet) + header (FIXED cortexmd branding) + tab-bar +
 * .content with each tab's server fragment + toast container + the ES-module
 * entry script. Composes tabs from the TABS registry — never hardcodes blocks.
 * See ARCHITECTURE.md §1/§4/§5.
 */
import { TABS } from './tabs.js';

/**
 * Asset cache-bust token. Bump on deploy (or wire to package version later).
 * Appended as `?v=` to the <link>/<script> URLs in renderPage().
 */
export const ASSET_VERSION = '1';

/** Minimal HTML-escape for the (static) tab labels. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPage(): string {
  const v = ASSET_VERSION;

  const tabBar = TABS.map((t, i) =>
    `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`,
  ).join('');

  const panels = TABS.map((t, i) =>
    `<div id="tab-${t.id}" class="tab-panel${i === 0 ? ' active' : ''}">${t.render()}</div>`,
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cortexmd &mdash; Control Panel</title>
<link rel="stylesheet" href="/dashboard/assets/app.css?v=${v}">
</head>
<body>

<div class="shell">
<div class="header">
  <h1>
    <span class="brand-mark" aria-hidden="true">&#9635;</span>
    <span class="brand">cortexmd</span> <span class="h1-sub">Control Panel</span>
  </h1>
  <div class="status-group">
    <div class="status-badge"><span class="status-dot"></span> Online</div>
    <span id="uptime">&mdash;</span>
    <span id="clock">&mdash;</span>
    <form method="POST" action="/logout" style="margin:0">
      <button type="submit" class="btn">Logout</button>
    </form>
  </div>
</div>

<div class="tab-bar">
  ${tabBar}
</div>

<div class="content">
${panels}
</div><!-- .content -->
</div><!-- .shell -->

<div class="toast-container" id="toastContainer"></div>

<script type="module" src="/dashboard/assets/app.js?v=${v}"></script>
</body>
</html>`;
}
