/**
 * Memories tab — server-rendered fragment for #tab-memories.
 *
 * The human inbox for what agents stored: a searchable, filterable list that
 * defaults to "stored in the last 24 h", and a detail drawer (rendered content,
 * frontmatter/provenance, heat/access, links in/out, supersession) with edit,
 * archive (the safe default), mark-as-noise and delete actions. Deep links:
 * #memories/<vault path>. Filled by assets/tabs/memories.js.
 */
import { sectionHead, emptyState } from '../components.js';

export function renderMemoriesTab(): string {
  return `
  <form class="card lab-form" id="memFilters" autocomplete="off">
    <div class="lab-query-row">
      <label class="sr-only" for="memQ">Search memories</label>
      <input class="input" id="memQ" name="q" type="search" placeholder="Search title, path or content…">
      <button class="btn btn-primary" type="submit">Search</button>
    </div>
    <div class="filter-grid">
      <div class="field"><label class="field-label" for="memSince">Stored</label>
        <select class="select" id="memSince" name="since">
          <option value="1" selected>last 24 h</option>
          <option value="7">last 7 days</option>
          <option value="30">last 30 days</option>
          <option value="all">any time</option>
        </select></div>
      <div class="field"><label class="field-label" for="memCategory">Category</label>
        <select class="select" id="memCategory" name="category"><option value="">any</option></select></div>
      <div class="field"><label class="field-label" for="memTemp">Temperature</label>
        <select class="select" id="memTemp" name="temperature"><option value="">any</option></select></div>
      <div class="field field--check">
        <label><input type="checkbox" id="memArchived" name="archived" value="1"> include archived</label>
        <label><input type="checkbox" id="memAll" name="all" value="1"> all notes, not just memories</label>
      </div>
    </div>
    <details class="lab-filters">
      <summary>Provenance filters (agent, machine, project, source)</summary>
      <div class="filter-grid">
        <div class="field"><label class="field-label" for="memAgent">Agent</label>
          <input class="input mono" id="memAgent" name="agent" placeholder="contains…"></div>
        <div class="field"><label class="field-label" for="memMachine">Machine</label>
          <input class="input mono" id="memMachine" name="machine" placeholder="contains…"></div>
        <div class="field"><label class="field-label" for="memProject">Project</label>
          <input class="input mono" id="memProject" name="project" placeholder="contains…"></div>
        <div class="field"><label class="field-label" for="memSource">Source</label>
          <input class="input mono" id="memSource" name="source" placeholder="contains…"></div>
      </div>
      <div class="card-sub">Read from each note's frontmatter (agent, machine, project/related [[Projects/…]], source/context) — notes without these fields will not match.</div>
    </details>
  </form>

  <div class="mem-layout">
    <div class="card mem-list-card">
      ${sectionHead('Inbox', '<span class="card-sub" id="memCount" style="margin:0" aria-live="polite">—</span>')}
      <div id="memList" class="mem-list" role="list">
        <div class="empty-msg" style="padding:0">Loading…</div>
      </div>
    </div>
    <aside class="card mem-drawer" id="memDrawer" aria-label="Memory detail" tabindex="-1">
      <div id="memDetail">
        ${emptyState('Nothing selected', 'Pick a memory from the inbox to read, edit, archive or delete it.')}
      </div>
    </aside>
  </div>

  <dialog class="dlg" id="memConfirm" aria-labelledby="memConfirmTitle">
    <form method="dialog" class="dlg-body">
      <h2 class="section-title" id="memConfirmTitle">Confirm</h2>
      <p id="memConfirmText" class="dlg-text"></p>
      <div class="field" id="memConfirmReasonWrap">
        <label class="field-label" for="memConfirmReason">Reason (logged to the journal)</label>
        <input class="input" id="memConfirmReason" maxlength="300">
      </div>
      <div class="dlg-actions">
        <button class="btn" value="cancel" type="submit">Cancel</button>
        <button class="btn btn-primary" value="ok" type="submit" id="memConfirmOk">Confirm</button>
      </div>
    </form>
  </dialog>`;
}
