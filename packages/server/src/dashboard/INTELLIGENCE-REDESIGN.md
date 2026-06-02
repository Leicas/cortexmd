# Intelligence Tab — Redesign Specification (final, buildable)

Merged from Proposal A (UX/IA) and Proposal B (data-viz). This is the single
source of truth for the frontend engineer. Every decision below is final and
unambiguous: exact band order, exact `col-*` classes, exact CSS to add, exact
empty-state treatment, and which id goes where.

Files touched:
- `packages/server/src/dashboard/views/tabs/intelligence.ts` — the HTML fragment (full rewrite of band order/containers).
- `packages/server/src/dashboard/assets/app.css` — grid classes only (one-line addition).
- `packages/server/src/dashboard/assets/tabs/intelligence.js` — **DO NOT TOUCH.** Every id is preserved; the client's `getElementById` writes are indifferent to the ancestor container. No binding moves.

Constraints honored: server-rendered MVC, no framework/bundler/deps, no inline `<script>`, shared `EventSource` untouched. Reuse `kpi`/`sectionHead` from `components.ts` and existing tokens/classes. Charts keep their svg ids + `viewBox="0 0 600 140"`.

---

## 1. Decisions on the two proposals (what we kept and why)

| Topic | Proposal A | Proposal B | FINAL DECISION |
|---|---|---|---|
| KPI + gauge | Keep as two bands (Zone 1 + Zone 2) | **Fuse** into one Vitals band | **Fuse (B).** One Vitals band: KPI row + so-what + gauge/factors row. Hero story above the fold. |
| Gauge width | col-4 | col-3 | **col-3 (B)** — frees col-9 for the horizontal factor bars, which benefit from length. |
| Duplicate score number | Demote to caption | Demote to caption | **Demote (both agree).** `healthScoreValue` becomes a small grade caption under the gauge; id kept. |
| Dream buttons location | Move into Vitals header (Zone 2) | Keep in Dream band header | **Keep in Dream band (B).** Lower risk — buttons stay adjacent to the narrative they produce; the Dream band sits directly under Vitals, so the CTA is still high. |
| Themes / Recs / Orphans | Recs+Themes col-6/col-6, orphans collapsed in `<details>` | **3-up** col-4/col-4/col-4 single row | **3-up (B), reordered.** One row: Recommendations (left, actionable) + Themes (mid) + Orphans (right). Orphan table stays inline (not collapsed) but capped + scrolled. |
| Entity + KG | Collapsed in `<details>`, col-6/col-6 | Always-open, **col-8/col-4** | **Always-open, col-8/col-4 (B).** Entity+KG draw from steady stats (not a dream), so they are rarely empty — keeping them open preserves first-impression density. col-8/col-4 matches Entity's higher density. |
| Dream History + Agents | Collapsed in `<details>`, col-6/col-6 | Always-open, col-7/col-5 | **Collapsed in `<details>` (A), col-7/col-5 inside.** This is the most empty-heavy, lowest-priority diagnostic before a dream runs; collapsing it is the biggest scroll win. Uses the existing `details.section` pattern (zero new CSS). col-7/col-5 is valid once the grid fix lands. |
| Grid bug fix | Complete 12-col system in CSS | Complete 12-col system in CSS | **Complete the system (both agree).** Add the missing col classes; this is the root-cause fix and unblocks col-5/7/9. |
| Empty states | Demote heavy panels to `<details>`; use `emptyState()` for open panels | Replace tall `.empty-msg` with compact `emptyState()`; gate by data tier | **Both.** Collapse the History+Agents diagnostic; for the static server-rendered defaults that stay open, keep the existing `.empty-msg` placeholders **as-is** (the client already swaps several to `emptyHtml()` on refresh, and we are forbidden from editing the JS). See §4. |

Net result: **7 stacked bands → 3 always-open bands + 1 collapsed disclosure.** Scroll roughly halved; hero health story + primary action above the fold; the empty-heavy history diagnostic hidden until expanded.

---

## 2. Band-by-band layout (final)

Render order (top → bottom):

### Band 1 — VITALS (KPIs + so-what + gauge + factors)
One band, two internal `.grid` rows + the so-what strip between them.

| Element | Container col class | ids inside |
|---|---|---|
| KPI: Vault Health | `col-3` (kpi tile) | `kpiHealthVal`, `kpiHealthSub`, `kpiHealthPill`, `kpiHealthDelta`, `kpiHealthSpark` |
| KPI: Entity Confirmation | `col-3` | `kpiEntityVal`, `kpiEntitySub`, `kpiEntityPill` |
| KPI: KG Density | `col-3` | `kpiKgVal`, `kpiKgSub`, `kpiKgPill` |
| KPI: Dream Cadence | `col-3` | `kpiDreamVal`, `kpiDreamSub`, `kpiDreamPill` |
| So-what strip (full width, between rows) | `.sowhat` (no col) | `intelSoWhat` |
| Health gauge card | `col-3 card card--center` | `healthGauge` (svg), `healthScoreValue` (caption), `healthGradeValue` (caption) |
| Health factors card | `col-9 card` | `healthFactors` |

- KPI row 1: `<div class="grid">` with 4× `col-3` (unchanged from current Band A).
- So-what strip: `<div class="sowhat" id="intelSoWhat"></div>` placed **between** the two grid rows.
- Vitals row 2: `<div class="grid">` with `col-3` gauge + `col-9` factors.
- Gauge card retains: `class="chart-wrap" style="height:150px"`, the svg `viewBox="0 0 600 140"`, and the baseline caption line holding both `healthScoreValue` and `healthGradeValue`. Do **not** render a second big number — the gauge prints the score.

### Band 2 — DREAM ENGINE (run controls + narrative + LLM)
`<div class="grid">`, unchanged proportions (col-8/col-4 already exist).

| Element | Container col class | ids inside |
|---|---|---|
| Dream Insights (status + buttons + narrative + activity) | `col-8 card` | `dreamStatus`, `btnDreamRun`, `btnDreamLlm`, `dreamNarrative`, `dreamActivity` |
| Local LLM sidecar | `col-4 card` | `llmPill`, `llmModel`, `llmUrl`, `llmError`, `llmSuggestions` |

- Header via `sectionHead('Dream Insights', …)` keeping the three nodes verbatim:
  - `<span id="dreamStatus" class="card-sub" style="margin-top:0">No dream run yet</span>`
  - `<button class="btn btn-primary" id="btnDreamRun" onclick="cortex.runDreamCycle(false)">Run Dream</button>`
  - `<button class="btn" id="btnDreamLlm" onclick="cortex.runDreamCycle(true)">LLM Dream</button>`
- `dreamActivity` **must keep** `class="grid" style="grid-template-columns:repeat(3,1fr);…"` — the client replaces its innerHTML with 3-col activity tiles.

### Band 3 — DREAM FINDINGS (recommendations + themes + orphans, 3-up)
`<div class="grid">`, three equal `col-4` cards, scroll-capped. Recommendations placed **left** (primary actionable scan side).

| Element | Container col class | ids inside |
|---|---|---|
| AI Recommendations | `col-4 card` | `recsCount`, `aiRecommendations` (holds JS-generated `cortex.dismissRec(...)` buttons) |
| Theme Clusters | `col-4 card` | `themeClusters` |
| Orphan Memories | `col-4 card` | `orphanSummary`, `orphanTableBody` |

- Orphan table keeps all **5** columns (Title / Temp / Heat / Last Access / Suggested Action) and its `colspan="5"` empty row. Wrap in `.table-wrap` (which is `overflow:auto`) so the 5-col table scrolls horizontally inside the narrow card. `orphanSummary` carries the at-a-glance badge signal.
- Recommendations header via `sectionHead('AI Recommendations', '<span id="recsCount" class="card-sub" style="margin-top:0"></span>')`.

### Band 4 — STRUCTURE (Entity + KG) — always open
`<div class="grid">`, **col-8 / col-4** (remapped from the buggy col-7/col-5).

| Element | Container col class | ids inside |
|---|---|---|
| Entity Intelligence | `col-8 card` | `eiTotal`, `eiConfirmed`, `eiDetected`, `entityTierBar`, `entityTypeBars`, `entityRegistryBody`, `btnEntityRebuild` |
| Knowledge Graph | `col-4 card` | `kgEntities`, `kgTriples`, `kgPredicates`, `btnKgBootstrap` |

- `btnEntityRebuild` stays in `sectionHead('Entity Intelligence', '<button class="btn btn-primary" id="btnEntityRebuild" onclick="cortex.rebuildEntities()">Rebuild entities</button>')`.
- `btnKgBootstrap` stays in `sectionHead('Knowledge Graph', '<button class="btn btn-primary" id="btnKgBootstrap" onclick="cortex.postAction(\'/dashboard/api/kg/bootstrap\',{})">Bootstrap KG</button>')`.
- Entity registry table keeps **4** columns + `colspan="4"` empty row. Stat tiles keep their inline `grid-template-columns:repeat(3,1fr)`; KG stats keep `repeat(2,1fr)`.

### Band 5 — HISTORY & AGENTS (Dream History + Agent Awareness) — COLLAPSED `<details>`
Wrap in the existing `details.section` disclosure, **closed by default** (no `open` attribute). Inside, one `<div class="grid">` with **col-7 / col-5**.

| Element | Container col class | ids inside |
|---|---|---|
| Dream History | `col-7 card` | `chartDreamHealth` (svg), `dreamHistoryTable` |
| Agent Awareness | `col-5 card` | `agentDiariesBody`, `agentRecentActivity` |

- Disclosure markup:
  ```html
  <details class="section">
    <summary>History &amp; Agents</summary>
    <div class="grid"> …col-7 / col-5… </div>
  </details>
  ```
- `chartDreamHealth` keeps svg `viewBox="0 0 600 140" preserveAspectRatio="none"` and its `.chart-legend`.
- Agent table keeps **3** columns + `colspan="3"` empty row.
- **Hidden-chart caveat:** `chartDreamHealth` lives in a closed disclosure, so its SVG renders at 0 height until the user expands it. The client's `drawMulti` writes to the svg id regardless of open/closed state. If `drawMulti` computes NaN/empty paths against a 0-height target and that proves visible-on-expand-broken in testing, the **only** permitted remedy (since JS is off-limits) is to add the `open` attribute to this one `<details>` so it renders with size. Default to **closed**; flip to `open` only if testing shows broken paths after expand.

Final concatenation order in `renderIntelligenceTab()`:
`vitalsKpis + soWhat + vitalsGauge + dreamEngine + findings + structure + historyAgents`

---

## 3. Grid fix (exact CSS to add)

**Root cause:** `app.css` defines only `.col-2/.col-3/.col-4/.col-6/.col-8/.col-12`. The tab uses `.col-5`, `.col-7`, and (after this redesign) `.col-9`. Undefined classes get no `grid-column` span and collapse to 1/12 width — the squished-left cards with an empty void on the right.

**Fix:** complete the 12-col ladder. In `packages/server/src/dashboard/assets/app.css`, replace the existing two-line col block (lines 188–189):

```css
.col-2{grid-column:span 2}.col-3{grid-column:span 3}.col-4{grid-column:span 4}
.col-6{grid-column:span 6}.col-8{grid-column:span 8}.col-12{grid-column:span 12}
```

with the complete ladder:

```css
.col-1{grid-column:span 1}.col-2{grid-column:span 2}.col-3{grid-column:span 3}
.col-4{grid-column:span 4}.col-5{grid-column:span 5}.col-6{grid-column:span 6}
.col-7{grid-column:span 7}.col-8{grid-column:span 8}.col-9{grid-column:span 9}
.col-10{grid-column:span 10}.col-11{grid-column:span 11}.col-12{grid-column:span 12}
```

- The existing mobile rule `@media(max-width:900px){[class*=col-]{grid-column:1/-1}}` (line 190) already catches all new classes — **no responsive work needed.**
- No new tokens, no new dependencies. Six one-line rules added; all use the same `repeat(12,1fr)` grid var.
- This single change fixes every collapse (Band 5 col-7/col-5, Vitals col-9) and hardens the system against future col-5/7/9/etc. use.

---

## 4. Empty-state rules

Two moves produce a short, deliberate first paint:

1. **Collapse the empty-heaviest diagnostic.** Band 5 (Dream History + Agent Awareness) is wrapped in a closed `details.section`. Collapsed, it is a single clean summary line — not a wall of "No dream cycles recorded yet." placeholders. This is the largest scroll/empty-footprint reduction and uses zero new CSS.

2. **Keep the open panels' server-rendered defaults exactly as they are.** Because `intelligence.js` is off-limits and the client already swaps several panels to its richer `emptyHtml()` / `emptyState()` on refresh, the server fragment must **preserve the existing literal `.empty-msg` placeholder strings and the `colspan` empty rows verbatim** for every open panel. Do not introduce a new server-side empty component — that would diverge from what the client re-renders and risks a contract mismatch. Specifically keep, unchanged:
   - `dreamNarrative` → `<span class="empty-msg">Run a dream cycle to analyze your vault…</span>` (inside `card card--quiet`, keep `min-height:60px`).
   - `themeClusters`, `aiRecommendations`, `llmSuggestions`, `kgPredicates` → their existing `.empty-msg` strings.
   - `orphanTableBody` (colspan 5), `entityRegistryBody` (colspan 4), `agentDiariesBody` (colspan 3) → their existing empty `<tr>` rows.
   - `healthFactors` → `<span class="empty-msg">Awaiting health data…</span>`.

**Data-availability framing (why the cold tab isn't all-empty):** Vitals KPIs + gauge + factors and the Entity/KG band draw from steady stats (health, entity confirmation, KG density), not from a dream — so the top of the page carries real numbers on first paint. Only the Dream Findings row (Band 3) and the dream narrative are empty before a dream runs, and Findings is now a single tidy 3-up row, not three stacked full-width bands. The History diagnostic is collapsed. Net cold-paint: real KPIs + gauge skeleton (`—` is the correct skeleton state) + one compact empty findings row + a collapsed disclosure.

Do **not** pre-open any disclosure (except the conditional `chartDreamHealth` remedy in §2 Band 5 if testing requires it).

---

## 5. ID-preservation checklist (all 49 — must all exist post-rewrite)

Tick that every id below still appears exactly once with the same id, in the band noted.

**Band 1 — Vitals**
- [ ] `kpiHealthVal` `kpiHealthSub` `kpiHealthPill` `kpiHealthDelta` `kpiHealthSpark`
- [ ] `kpiEntityVal` `kpiEntitySub` `kpiEntityPill`
- [ ] `kpiKgVal` `kpiKgSub` `kpiKgPill`
- [ ] `kpiDreamVal` `kpiDreamSub` `kpiDreamPill`
- [ ] `intelSoWhat`
- [ ] `healthGauge` (svg, `viewBox="0 0 600 140"`) `healthScoreValue` (caption) `healthGradeValue` (caption) `healthFactors`

**Band 2 — Dream Engine**
- [ ] `dreamStatus` `btnDreamRun` `btnDreamLlm` `dreamNarrative` `dreamActivity`
- [ ] `llmPill` `llmModel` `llmUrl` `llmError` `llmSuggestions`

**Band 3 — Dream Findings**
- [ ] `recsCount` `aiRecommendations`
- [ ] `themeClusters`
- [ ] `orphanSummary` `orphanTableBody`

**Band 4 — Structure**
- [ ] `eiTotal` `eiConfirmed` `eiDetected` `entityTierBar` `entityTypeBars` `entityRegistryBody` `btnEntityRebuild`
- [ ] `kgEntities` `kgTriples` `kgPredicates` `btnKgBootstrap`

**Band 5 — History & Agents (collapsed `<details>`)**
- [ ] `chartDreamHealth` (svg, `viewBox="0 0 600 140"`) `dreamHistoryTable`
- [ ] `agentDiariesBody` `agentRecentActivity`

**Action-button bridges (copy verbatim):**
- [ ] `btnDreamRun` → `onclick="cortex.runDreamCycle(false)"`
- [ ] `btnDreamLlm` → `onclick="cortex.runDreamCycle(true)"`
- [ ] `btnEntityRebuild` → `onclick="cortex.rebuildEntities()"`
- [ ] `btnKgBootstrap` → `onclick="cortex.postAction('/dashboard/api/kg/bootstrap',{})"`
- [ ] `cortex.dismissRec(...)` — generated by JS inside `aiRecommendations`; untouched.

**Structural invariants:**
- [ ] `dreamActivity` keeps `style="grid-template-columns:repeat(3,1fr)"`.
- [ ] Table column counts unchanged: orphans 5, entity registry 4, agents 3 (thead + colspan match).
- [ ] No inline `color` on kpi/button tiles — rely on global `button{color:inherit}` + `.card--kpi{color:var(--text)}`. (Existing `style="color:var(--ok)"` / `var(--warn)` on `eiConfirmed`/`eiDetected` are token-based and fine to keep.)
- [ ] `app.css` col block extended to the full 1–12 ladder (§3).
- [ ] `intelligence.js` not modified.

---

## 6. Build summary for the engineer

1. Edit `app.css` lines 188–189 → full col ladder (§3).
2. Rewrite `renderIntelligenceTab()` band order/containers per §2; concatenate `vitalsKpis + soWhat + vitalsGauge + dreamEngine + findings + structure + historyAgents`.
3. Remap Entity+KG to col-8/col-4; wrap History+Agents in `details.section` (closed) with inner col-7/col-5.
4. Demote `healthScoreValue` to the gauge caption line (keep id; no second hero number).
5. Verify the §5 checklist — every id present, every onclick verbatim, table colspans intact.
6. Test cold paint + post-dream paint. If `chartDreamHealth` paths break on first expand, add `open` to that one `<details>` (only permitted JS-free remedy).
