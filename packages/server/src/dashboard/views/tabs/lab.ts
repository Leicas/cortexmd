/**
 * Recall Lab tab — server-rendered fragment for #tab-lab.
 *
 * "Why did the agent get THIS memory?" — three sub-views behind a segmented
 * control (deep-linkable as #lab/playground, #lab/wakeup, #lab/eval):
 *   - Playground: run the exact `memory_recall` path (explain on, no-touch) and
 *     read a per-result signal breakdown (text values, not colour alone).
 *   - Wakeup inspector: what `memory_wakeup` would inject for a preset / agent /
 *     project, with per-layer token bars against the budget and the L1 notes.
 *   - Eval: run history from the recall eval harness results dir, per-category
 *     Recall@5 / MRR / p95 trend, and a regression drill-down vs a baseline.
 *
 * All dynamic content is filled by assets/tabs/lab.js via /dashboard/api/*.
 */
import { sectionHead, emptyState } from '../components.js';

const CATEGORIES = ['observation', 'decision', 'insight', 'conversation', 'fact', 'preference', 'plan', 'reflection'];

function opt(v: string, label = v): string {
  return `<option value="${v}">${label}</option>`;
}

export function renderLabTab(): string {
  const seg = `
  <div class="seg-control" role="tablist" aria-label="Recall Lab views" id="labSeg">
    <button type="button" role="tab" class="seg-btn active" data-lab-view="playground" aria-selected="true" aria-controls="labPlayground">Playground</button>
    <button type="button" role="tab" class="seg-btn" data-lab-view="wakeup" aria-selected="false" aria-controls="labWakeup">Wakeup inspector</button>
    <button type="button" role="tab" class="seg-btn" data-lab-view="eval" aria-selected="false" aria-controls="labEval">Eval</button>
  </div>`;

  const playground = `
  <section id="labPlayground" class="lab-view" role="tabpanel" aria-label="Recall playground">
    <form class="card lab-form" id="labRecallForm" autocomplete="off">
      <div class="lab-query-row">
        <label class="sr-only" for="labQuery">Recall query</label>
        <input class="input" id="labQuery" name="query" type="search" placeholder="Ask the memory what an agent would ask…" required>
        <button class="btn btn-primary" type="submit" id="labRunBtn">Recall</button>
      </div>
      <details class="lab-filters">
        <summary>Filters</summary>
        <div class="filter-grid">
          <div class="field"><label class="field-label" for="labLimit">Limit</label>
            <input class="input mono" id="labLimit" name="limit" type="number" min="1" max="50" value="10"></div>
          <div class="field"><label class="field-label" for="labCategory">Category</label>
            <select class="select" id="labCategory" name="categories">${opt('', 'any')}${CATEGORIES.map((c) => opt(c)).join('')}</select></div>
          <div class="field"><label class="field-label" for="labTemp">Temperature</label>
            <select class="select" id="labTemp" name="temperature">${opt('any')}${opt('hot')}${opt('warm')}${opt('cold')}</select></div>
          <div class="field"><label class="field-label" for="labImp">Min importance</label>
            <select class="select" id="labImp" name="minImportance">${opt('', 'any')}${opt('low')}${opt('medium')}${opt('high')}${opt('critical')}</select></div>
          <div class="field filter-wide"><label class="field-label" for="labRelated">Related to (paths, comma-separated)</label>
            <input class="input mono" id="labRelated" name="relatedTo" placeholder="Projects/cortexmd, Concepts/BM25"></div>
          <div class="field"><label class="field-label" for="labFrom">Date from</label>
            <input class="input mono" id="labFrom" name="dateFrom" type="date"></div>
          <div class="field"><label class="field-label" for="labTo">Date to</label>
            <input class="input mono" id="labTo" name="dateTo" type="date"></div>
        </div>
      </details>
      <div class="card-sub lab-note">Runs the same function as <span class="mono">memory_recall</span> with <span class="mono">explain</span> on. Read-only: access counts and co-recall are not touched.</div>
    </form>
    <div id="labResultsMeta" class="sowhat" aria-live="polite"></div>
    <div id="labResults" class="lab-results">
      ${emptyState('No query yet', 'Type a query above to see what recall returns and why each memory surfaced.')}
    </div>
  </section>`;

  const wakeup = `
  <section id="labWakeup" class="lab-view" role="tabpanel" aria-label="Wakeup inspector" hidden>
    <form class="card lab-form" id="labWakeForm" autocomplete="off">
      <div class="filter-grid">
        <div class="field"><label class="field-label" for="wkPreset">Preset</label>
          <select class="select" id="wkPreset" name="preset">${opt('tiny', 'tiny · 180 tokens')}<option value="standard" selected>standard · 900 tokens</option>${opt('full', 'full · 2000 tokens')}</select></div>
        <div class="field"><label class="field-label" for="wkAgent">Agent</label>
          <input class="input mono" id="wkAgent" name="agent" list="wkAgentList" placeholder="Claude Code (host)"><datalist id="wkAgentList"></datalist></div>
        <div class="field"><label class="field-label" for="wkProject">Project</label>
          <input class="input mono" id="wkProject" name="project" list="wkProjectList" placeholder="repo slug"><datalist id="wkProjectList"></datalist></div>
        <div class="field field--action"><button class="btn btn-primary" type="submit">Inspect</button></div>
      </div>
    </form>
    <div class="grid">
      <div class="col-7 card">
        ${sectionHead('What the agent receives', '<span class="card-sub" id="wkTotal" style="margin:0">—</span>')}
        <div id="wkLayers"><div class="empty-msg" style="padding:0">Pick a preset and press Inspect.</div></div>
      </div>
      <div class="col-5 card">
        ${sectionHead('Notes feeding L1', '<span class="card-sub" id="wkNotesCount" style="margin:0"></span>')}
        <div id="wkNotes"><div class="empty-msg" style="padding:0">—</div></div>
      </div>
    </div>
  </section>`;

  const evalView = `
  <section id="labEval" class="lab-view" role="tabpanel" aria-label="Recall eval" hidden>
    <div class="card">
      ${sectionHead('Run history', '<button class="btn btn--sm" type="button" id="evalReload">Reload</button>')}
      <div class="card-sub" id="evalDir" style="margin:0 0 .6rem"></div>
      <div id="evalHistory"></div>
      <div id="evalEmpty" hidden>
        ${emptyState('No eval runs found', 'Run the recall eval harness (npm run eval:realvault in packages/server) — each run writes a JSON file to the results directory shown above, and it appears here. Set RECALL_EVAL_RESULTS_DIR to read another directory.')}
      </div>
    </div>
    <div class="grid" id="evalBody" hidden>
      <div class="col-12 card">
        ${sectionHead('Trend by category', '<label class="sr-only" for="evalCat">Category</label><select class="select select--inline" id="evalCat"></select>')}
        <div class="trend-grid">
          <div><div class="card-label">Recall@5</div><div class="chart-wrap chart-wrap--sm"><svg id="evalTrendR5" viewBox="0 0 600 140" preserveAspectRatio="none"></svg></div><div class="card-sub" id="evalTrendR5Txt"></div></div>
          <div><div class="card-label">MRR</div><div class="chart-wrap chart-wrap--sm"><svg id="evalTrendMrr" viewBox="0 0 600 140" preserveAspectRatio="none"></svg></div><div class="card-sub" id="evalTrendMrrTxt"></div></div>
          <div><div class="card-label">p95 latency</div><div class="chart-wrap chart-wrap--sm"><svg id="evalTrendP95" viewBox="0 0 600 140" preserveAspectRatio="none"></svg></div><div class="card-sub" id="evalTrendP95Txt"></div></div>
        </div>
      </div>
      <div class="col-12 card">
        ${sectionHead('Regressions vs baseline', `
          <label class="field-label" for="evalBase">Baseline</label><select class="select select--inline" id="evalBase"></select>
          <label class="field-label" for="evalRun">Run</label><select class="select select--inline" id="evalRun"></select>`)}
        <div id="evalDiffSummary" class="sowhat" aria-live="polite"></div>
        <div id="evalDiff"></div>
      </div>
    </div>
  </section>`;

  return seg + playground + wakeup + evalView;
}
