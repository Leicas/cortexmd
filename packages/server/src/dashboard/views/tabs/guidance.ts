/**
 * Guidance Packs tab — installed third-party best-practice packs (commit,
 * entries, last sync), a search box over them, and add / sync / remove.
 * Server fragment only; assets/tabs/guidance.js fills it from
 * /dashboard/api/guidance/*. Every mutation is a same-origin POST/DELETE, so
 * the CSRF header is added by the fetch patch in core.js.
 */
import { card, sectionHead } from '../components.js';

export function renderGuidanceTab(): string {
  const packs = card(`
    ${sectionHead('Installed packs', '<span class="card-label" id="guidanceHosts" style="margin:0"></span>')}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Pack</th><th>Source</th><th>Commit</th><th>Licence</th><th>Entries</th><th>Last sync</th><th>Actions</th></tr>
        </thead>
        <tbody id="guidancePacksBody"></tbody>
      </table>
    </div>
    <div class="card-label" style="margin-top:.6rem">Pack content is third-party reference data stored outside the vault; it never enters recall, the graph or dream.</div>
  `);

  const add = card(`
    ${sectionHead('Add a pack', '')}
    <div class="field" style="margin-bottom:.6rem">
      <label class="field-label" for="guidanceName">Name</label>
      <input class="input" id="guidanceName" type="text" placeholder="modern-web-guidance" autocomplete="off" />
    </div>
    <div class="field" style="margin-bottom:.6rem">
      <label class="field-label" for="guidanceSource">Git URL (https, allowlisted host)</label>
      <input class="input mono" id="guidanceSource" type="text" placeholder="https://github.com/GoogleChrome/modern-web-guidance" autocomplete="off" />
    </div>
    <div class="field" style="margin-bottom:.6rem">
      <label class="field-label" for="guidanceRef">Branch, tag or full commit sha (optional)</label>
      <input class="input mono" id="guidanceRef" type="text" autocomplete="off" />
    </div>
    <button type="button" class="btn btn-primary" data-cx-click="cortex.guidanceAdd()">Add &amp; sync</button>
  `);

  const search = card(`
    ${sectionHead('Search guides', '')}
    <div style="display:flex;gap:.5rem">
      <input class="input" id="guidanceQuery" type="search" placeholder="light dismiss dialog" aria-label="Search guidance packs" style="flex:1" />
      <button type="button" class="btn" data-cx-click="cortex.guidanceSearch()">Search</button>
    </div>
    <div id="guidanceResults" style="margin-top:.75rem"></div>
    <pre id="guidanceGuide" class="mono" style="margin-top:.75rem;white-space:pre-wrap;max-height:28rem;overflow:auto;display:none"></pre>
  `);

  return packs + search + add;
}
