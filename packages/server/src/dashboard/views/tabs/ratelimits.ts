/**
 * Rate Limits tab — server-rendered HTML fragment for #tab-ratelimits.
 *
 * Migrated from the legacy `dashboard.ts` (the `<!-- TAB 3: Rate Limits -->`
 * block), minus the outer `<div id="tab-ratelimits" class="tab-panel">` wrapper
 * which the layout now supplies. The inline flex header is replaced by the
 * `sectionHead` component; the "Reset All" action calls the core-seeded
 * `cortex.postAction`. Fragment is static; the client module
 * `assets/tabs/ratelimits.js` fills `#rateLimitTableBody` over SSE.
 */
import { sectionHead } from '../components.js';

export function renderRateLimitsTab(): string {
  return `
  <div class="row row-1">
    <div class="card">
      ${sectionHead(
        'Rate Limits',
        `<button class="btn btn-danger" onclick="cortex.postAction('/dashboard/api/rate-limit/reset-all',{})">Reset All</button>`,
      )}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>IP Address</th>
              <th>Request Count</th>
              <th>Remaining</th>
              <th>Reset At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="rateLimitTableBody"></tbody>
        </table>
      </div>
    </div>
  </div>`;
}
