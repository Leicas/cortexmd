/**
 * Rate Limits tab — server-rendered HTML fragment for #tab-ratelimits.
 *
 * REVAMP.md §5 TAB 3: the data is *auth-failure throttling*, not capacity —
 * framed as SECURITY. Layout mirrors the Overview reference (REVAMP.md §5 TAB 1):
 *   • a header KPI strip (IPs throttled now · suspicious IPs · auth-failure rate)
 *   • the live table, now with a countdown bar to `resetAt` + per-IP health state.
 *
 * Data source is unchanged: `assets/tabs/ratelimits.js` fills `#rateLimitTableBody`
 * and the KPI ids over SSE from `ctx.data.rateLimits` / `recentAuthFailures` /
 * `derived`. Every action still calls the core-seeded `cortex.postAction` /
 * `cortex.resetRl`. Existing id `#rateLimitTableBody` is preserved.
 */
import { kpi, sectionHead } from '../components.js';

export function renderRateLimitsTab(): string {
  // ── Header KPI strip — the security read (REVAMP.md §5 TAB 3) ──────────────
  const kpiStrip = `
  <div class="grid">
    <div class="col-4">${kpi({
      label: 'IPs Throttled Now', valueId: 'rlThrottled', value: '0',
      subId: 'rlThrottledSub', sub: 'no IPs at limit', pillId: 'rlThrottledPill',
    })}</div>
    <div class="col-4">${kpi({
      label: 'Suspicious IPs', valueId: 'rlSuspicious', value: '0',
      subId: 'rlSuspiciousSub', sub: 'throttled + failing auth', pillId: 'rlSuspiciousPill',
    })}</div>
    <div class="col-4">${kpi({
      label: 'Auth Failures / min', valueId: 'rlAuthRate', value: '0',
      subId: 'rlAuthSub', sub: 'last 15 min', sparkId: 'rlAuthSpark',
    })}</div>
  </div>`;

  // ── "So what?" one-liner + live tracking table ────────────────────────────
  const table = `
  <div class="grid">
    <div class="col-12 card">
      ${sectionHead(
        'Tracked IPs',
        `<button type="button" class="btn btn-danger btn--sm" onclick="cortex.postAction('/dashboard/api/rate-limit/reset-all',{})">Reset All</button>`,
      )}
      <div class="sowhat" id="rlSoWhat"></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-col="ip">IP Address <span class="sort-arrow"></span></th>
              <th>Status</th>
              <th data-col="count" class="num">Auth Failures <span class="sort-arrow"></span></th>
              <th data-col="remaining" class="num">Remaining <span class="sort-arrow"></span></th>
              <th>Window Reset</th>
              <th class="num">Actions</th>
            </tr>
          </thead>
          <tbody id="rateLimitTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>`;

  return kpiStrip + table;
}
