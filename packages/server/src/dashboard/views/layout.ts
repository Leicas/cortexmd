/**
 * `renderPage()` — the dashboard HTML shell. Emits doctype + <head> (linking
 * the external stylesheet) + header (FIXED cortexmd branding + status/identity
 * chrome) + grouped tab-bar + .content with each tab's server fragment + toast
 * container + the ES-module entry script. Composes tabs from the TABS registry,
 * clustered into the 3 zones (Operations / Knowledge / Build). See REVAMP.md
 * §4/§6/§8. The SSE/tab contract is unchanged: buttons still carry data-tab and
 * panels are still #tab-<id> with .tab-panel.
 */
import { TABS, TAB_GROUP_LABELS, type TabGroup } from './tabs.js';

/**
 * Asset cache-bust token. Bump on deploy (or wire to package version later).
 * Appended as `?v=` to the <link>/<script> URLs in renderPage().
 */
export const ASSET_VERSION = '5';

/** Minimal HTML-escape for the (static) tab labels. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderPage(): string {
  const v = ASSET_VERSION;

  // Group the tabs into clusters (render order in TABS keeps groups contiguous).
  const order: TabGroup[] = ['ops', 'knowledge', 'build'];
  let flatIndex = 0;
  const groups = order.map((g) => {
    const tabs = TABS.filter((t) => t.group === g);
    const buttons = tabs
      .map((t) => {
        const active = flatIndex === 0;
        flatIndex++;
        return (
          `<button class="tab-btn${active ? ' active' : ''}" role="tab" id="tabbtn-${t.id}"` +
          ` data-tab="${t.id}" aria-controls="tab-${t.id}"` +
          ` aria-selected="${active ? 'true' : 'false'}"${active ? ' aria-current="page"' : ''}` +
          ` tabindex="${active ? '0' : '-1'}">${esc(t.label)}</button>`
        );
      })
      .join('');
    return (
      `<div class="tab-group" role="group" aria-label="${esc(TAB_GROUP_LABELS[g])}">` +
      `<span class="tab-group-label" aria-hidden="true">${esc(TAB_GROUP_LABELS[g])}</span>` +
      `${buttons}</div>`
    );
  }).join('');

  const panels = TABS.map((t, i) =>
    `<div id="tab-${t.id}" class="tab-panel${i === 0 ? ' active' : ''}" role="tabpanel" aria-labelledby="tabbtn-${t.id}" tabindex="0">${t.render()}</div>`,
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
<a class="skip" href="#main">Skip to content</a>

<div class="shell">
<div class="header">
  <h1>
    <span class="brand-mark" aria-hidden="true">&#9635;</span>
    <span class="brand">cortexmd</span> <span class="h1-sub">Control Panel</span>
  </h1>
  <div class="status-group">
    <div class="status-badge" aria-live="polite">
      <span class="status-dot" role="img" aria-label="Connection status"></span>
      <span class="sse-label"></span>
    </div>
    <span class="health-chip" id="healthChip" title="Vault health grade" aria-label="Vault health grade">&mdash;</span>
    <span id="uptime" title="Server uptime">&mdash;</span>
    <span id="lastUpdate" title="Time since last live update" aria-live="polite">&mdash;</span>
    <span id="clock" title="Local time">&mdash;</span>
    <button type="button" class="btn btn--sm" id="refreshBtn" title="Reconnect the live feed">Refresh</button>
    <form method="POST" action="/logout" style="margin:0">
      <button type="submit" class="btn btn--sm">Logout</button>
    </form>
  </div>
</div>

<div class="tab-bar" role="tablist" aria-label="Dashboard sections">
  ${groups}
</div>

<div class="content" id="main" tabindex="-1">
${panels}
</div><!-- .content -->
</div><!-- .shell -->

<div class="toast-container" id="toastContainer" aria-live="polite"></div>

<script type="module" src="/dashboard/assets/app.js?v=${v}"></script>
</body>
</html>`;
}
