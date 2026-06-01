# CORTEX — Dashboard Revamp Spec

**Status:** buildable spec (design lead merge of 3 specialist proposals).
**Scope:** `packages/server/src/dashboard/`. Server-rendered, native ES modules + CSS only.
**Hard constraints (do not violate):** no framework, no bundler, no new npm deps; keep the
single EventSource (`/dashboard/events`), the 8 tabs, and all existing payload fields / DOM ids /
endpoints. WCAG AA throughout.

The product identity: **CORTEX is a clinical instrument** (oscilloscope / MRI console), not an
"AI SaaS." Near-monochrome graphite so the data does the talking, plus **one** spectral signature
(violet→cyan) rationed to a handful of places. Every headline number answers *"is this good, and
which way is it moving?"* — not just *"what is it now?"*

Files touched:
- `assets/app.css` — token layer + component layer (most work; mostly additive / in-place redefine).
- `assets/lib/charts.js` — SVG helpers (`drawChart` upgrade + 3 new helpers).
- `views/layout.ts` — sprite, skip link, grouped tab bar, header affordances, ASSET_VERSION bump.
- `views/components.ts` — add `kpi()`, `statusPill()`, `sparkRow()`, `deltaChip()`, `emptyState()`.
- `views/tabs.ts` — add `group` field to `TabDef`.
- `views/tabs/*.ts` — markup reorg per §6 (no id removals).
- `assets/core.js` — ARIA on tab switch, `data-sse` text, last-update age, `.flash` toggle.
- `model/derive.ts` (**new**) + `model/payload.ts` — attach a `derived` namespace (the only
  server-logic addition; see §7). All derived values are O(payload) over already-capped arrays.

Rollout is phased (§9) so every step is independently shippable and reversible.

---

## 1. Design system — tokens

Replace the `:root` block in `app.css` wholesale with the following. **The legacy aliases at the
bottom are mandatory** — `charts.js`, `core.js`, and tab modules pass strings like `var(--blue)`,
`var(--green)`, `var(--red)`, `var(--yellow)` to helpers and CSS classes; keeping them as aliases
means zero JS edits for the color swap.

```css
:root{
  /* ── Surfaces — deeper, warmer graphite; wider card/elevated gap ── */
  --bg:        #07090e;   /* page */
  --bg-elev:   #0d1118;   /* sunken wells: inputs, chart troughs, feeds */
  --card:      #12161f;   /* primary surface */
  --card-2:    #181d28;   /* nested/raised inside a card; default btn face */
  --card-hover:#1b2130;
  --border:    #232a36;   /* hairline */
  --border-strong:#39434f;
  --line-faint:rgba(255,255,255,.05);  /* internal dividers */

  /* ── Text (AA-verified on --card #12161f) ── */
  --text:      #e3e8ef;   /* primary  — 14.9:1 (AAA) */
  --text-dim:  #93a0b0;   /* secondary — 5.9:1 (AA) */
  --text-faint:#6b7686;   /* tertiary/meta — 3.5:1; LARGE (>=18px) or non-essential text ONLY */
  --text-mute: #4d5563;   /* decorative only: axis ticks, disabled. NEVER body text. */

  /* ── Signature: spectral brand (use SCARCELY — see §1a) ── */
  --brand:      #8b7dff;  /* violet anchor — 6.1:1 on --card */
  --brand-2:    #45d9d2;  /* cyan anchor */
  --brand-grad: linear-gradient(100deg,#8b7dff 0%,#6fa8ff 45%,#45d9d2 100%);
  --brand-glow: 0 0 0 1px rgba(139,125,255,.35), 0 0 22px -6px rgba(139,125,255,.55);
  --brand-wash: rgba(139,125,255,.10);   /* primary-btn hover, active-row tint, flash */

  /* ── Semantic accents + fill/border companions (status, NOT identity) ── */
  --ok:   #46c266; --ok-fill:  rgba(70,194,102,.13); --ok-bd:  rgba(70,194,102,.30);
  --warn: #d8a02a; --warn-fill:rgba(216,160,42,.13); --warn-bd:rgba(216,160,42,.30);
  --err:  #f0625b; --err-fill: rgba(240,98,91,.13);  --err-bd: rgba(240,98,91,.32);
  --info: #5aa8ff; --info-fill:rgba(90,168,255,.13); --info-bd:rgba(90,168,255,.30);

  /* ── Legacy aliases (MANDATORY — referenced by JS strings + existing classes) ── */
  --blue:var(--info); --green:var(--ok); --red:var(--err); --yellow:var(--warn);
  --purple:#bc8cff; --accent-purple:#bc8cff;

  /* ── Typography ── */
  --font-sans:'Inter var','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  --mono:'Cascadia Code','JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;
  --num:'tnum' 1, 'cv11' 1;          /* tabular figures so live digits don't jitter */
  --fs-xs:.6875rem; --fs-sm:.75rem; --fs-md:.8125rem;
  --fs-lg:.9375rem; --fs-xl:1.125rem; --fs-2xl:1.625rem;
  --lh:1.5; --lh-tight:1.25;
  --tracking-cap:.07em; --tracking-tight:-.02em;

  /* ── Spacing (4px base) + purpose tokens ── */
  --sp-1:.25rem; --sp-2:.5rem; --sp-3:.75rem; --sp-4:1rem; --sp-5:1.5rem; --sp-6:2rem; --sp-8:3rem;
  --gutter:var(--sp-4);              /* grid gap + content padding */
  --card-pad:var(--sp-5);            /* panels */
  --card-pad-tight:var(--sp-4);      /* KPI tiles — denser, glanceable */

  /* ── Radius (tighter ladder = "instrument", less rounded = more precise) ── */
  --r-xs:4px; --r-sm:6px; --r-md:10px; --r-lg:14px; --r-pill:999px;

  /* ── Elevation — layered light (catch-light + ambient shadow) ── */
  --shadow-1:0 1px 2px rgba(0,0,0,.4);
  --shadow-2:0 6px 20px -4px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.35);
  --shadow-3:0 18px 48px -12px rgba(0,0,0,.65);
  --ring-top:inset 0 1px 0 rgba(255,255,255,.04);   /* the catch-light line */
  --inset-well:inset 0 1px 2px rgba(0,0,0,.45);      /* sunken inputs/feeds */

  /* ── Motion ── */
  --t-fast:.12s; --t:.18s; --t-slow:.32s;
  --ease:cubic-bezier(.2,.6,.2,1);
}
html{font-size:14px}
```

### 1a. Token-usage law (this is what keeps it from looking generic-AI)
- **`--brand*` is identity-only.** Allowed exactly at: the wordmark, the active-tab underline, the
  primary-button face, `:focus-visible`, the SSE "live" pulse, the KPI top hairline, and the
  `.flash` update tint. **Never** as a fill behind body text, never as a status color, never sprayed
  across cards. Scarcity is the point.
- **Status = semantic tokens only** (`--ok/--warn/--err/--info` + their `-fill`/`-bd`). Every KPI,
  badge, and row health state is driven by these via the threshold map (§7), never by `--brand`.
- **Sans is the product voice; mono is for machine data only** (IDs, latencies, timestamps, code
  paths, raw counts in tables/feeds). Hero KPI numbers are **sans** (`--fs-2xl`, weight 700) — this
  deliberately breaks the hacker-mono cliché. A `.card-value--mono` modifier keeps mono available
  where a raw ID genuinely belongs.

---

## 2. Design system — canonical components

All rules go in `app.css`. Existing class names are **redefined in place** (so the 8 tabs restyle
with zero markup edits); genuinely new classes are **additive**. Migrate inline `style="font-size…"`
sprawl in `vault.ts`/`intelligence.ts`/`overview.ts` onto these classes opportunistically.

### 2a. Card (panel + archetypes)
```css
.card{
  background:var(--card); border:1px solid var(--border); border-radius:var(--r-md);
  padding:var(--card-pad); box-shadow:var(--shadow-1),var(--ring-top);
  transition:border-color var(--t),box-shadow var(--t);
}
.card:hover{border-color:var(--border-strong);box-shadow:var(--shadow-2),var(--ring-top)}
/* NOTE: drop the old bg-swap-on-hover — a shadow lift reads as more refined than a color flip. */
.card--quiet{box-shadow:none;background:var(--bg-elev)}     /* nested/secondary panels */
.card--center{text-align:center}                            /* gauge cards */
.card--pad-sm{padding:var(--sp-3)}
```

### 2b. KPI tile — the signature readout
Structure is unchanged (`.card-label` / `.card-value` / `.card-sub`) so existing ids keep working.
Adds: spectral top hairline, an optional status pill, a delta chip, and a 28px sparkline foot.
KPI tiles use `--card-pad-tight`.
```css
.card--kpi{padding:var(--card-pad-tight);position:relative;overflow:hidden}
.card--kpi.is-link{cursor:pointer}
.card--kpi.is-link:hover{border-color:var(--border-strong)}
/* spectral top rule replaces the old flat border-top accent */
.card--accent,.card--kpi{position:relative}
.card--accent::before,.card--kpi::before{
  content:"";position:absolute;inset:0 0 auto 0;height:2px;background:var(--brand-grad);opacity:.9}
.card-label{
  display:flex;align-items:center;gap:.4rem;
  font:600 var(--fs-xs)/1 var(--font-sans);text-transform:uppercase;
  letter-spacing:var(--tracking-cap);color:var(--text-dim);margin-bottom:var(--sp-2)}
.card-value{
  font:700 var(--fs-2xl)/1 var(--font-sans);font-feature-settings:var(--num);
  letter-spacing:var(--tracking-tight)}
.card-value--mono{font-family:var(--mono)}     /* opt-in for raw IDs */
.card-sub{font:500 var(--fs-xs)/1.3 var(--mono);color:var(--text-dim);margin-top:var(--sp-2)}
.kpi-spark{height:28px;margin:.5rem -.25rem -.25rem;opacity:.85}   /* drives drawChart */
```

### 2c. Status pill + delta chip (insight layer)
Every headline number carries a good/warn/bad pill whose state is text-encoded (not color-only).
```css
.pill{display:inline-flex;align-items:center;gap:.3rem;
  padding:.1rem .45rem;border-radius:var(--r-pill);
  font:600 var(--fs-xs)/1.4 var(--mono);border:1px solid transparent}
.pill--ok  {color:var(--ok);  background:var(--ok-fill);  border-color:var(--ok-bd)}
.pill--warn{color:var(--warn);background:var(--warn-fill);border-color:var(--warn-bd)}
.pill--bad {color:var(--err); background:var(--err-fill); border-color:var(--err-bd)}
.pill--muted{color:var(--text-dim);background:var(--line-faint);border-color:var(--border)}
.pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor}

.kpi-delta{display:inline-flex;align-items:center;gap:.2rem;
  font:600 var(--fs-xs)/1 var(--mono);padding:.1rem .35rem;border-radius:var(--r-xs)}
.kpi-delta.up  {color:var(--ok); background:var(--ok-fill)}    /* "up = good" by default; */
.kpi-delta.down{color:var(--err);background:var(--err-fill)}   /* invert via .invert for error-rate KPIs */
.kpi-delta.flat{color:var(--text-faint);background:var(--line-faint)}
.kpi-delta.invert.up{color:var(--err);background:var(--err-fill)}
.kpi-delta.invert.down{color:var(--ok);background:var(--ok-fill)}
```
A delta chip shows the arrow glyph (↑/↓/→) **and** the % so it is never color-only.

### 2d. Table
```css
.table-wrap{overflow:auto;border-radius:var(--r-sm)}
table{width:100%;border-collapse:separate;border-spacing:0;font:var(--fs-sm)/1.4 var(--font-sans)}
thead th{position:sticky;top:0;z-index:1;background:var(--card);
  font:600 var(--fs-xs)/1 var(--font-sans);text-transform:uppercase;letter-spacing:.04em;
  color:var(--text-dim);padding:.6rem .75rem;border-bottom:1px solid var(--border-strong);
  white-space:nowrap;user-select:none}
th[data-col]{cursor:pointer}
th:hover{color:var(--text)}
th[aria-sort] .sort-arrow{opacity:1;color:var(--brand)}
td{padding:.55rem .75rem;border-bottom:1px solid var(--line-faint);color:var(--text)}
td.num,.mono{font-family:var(--mono);font-feature-settings:var(--num);text-align:right}
tbody tr{transition:background var(--t-fast)}
tbody tr:hover{background:var(--brand-wash)}
tbody tr:hover td:first-child{box-shadow:inset 2px 0 0 var(--brand)}   /* edge marker, not a wash */
tbody tr:last-child td{border-bottom:none}
.lat-green{color:var(--ok)} .lat-yellow{color:var(--warn)} .lat-red{color:var(--err)}
.err-red{color:var(--err);font-weight:600}
```
Rule: **mono only on numeric columns** (`td.num`, right-aligned, tabular). Text columns are sans.
`core.js` sort handler must `setAttribute('aria-sort', 'ascending'|'descending')` on the active `th`.

### 2e. Badge — unify on semantic triplets
```css
.badge{display:inline-flex;align-items:center;gap:.3rem;
  padding:.15rem .5rem;border-radius:var(--r-pill);
  font:600 var(--fs-xs)/1.4 var(--mono);border:1px solid transparent}
.badge--ok  {color:var(--ok);  background:var(--ok-fill);  border-color:var(--ok-bd)}
.badge--warn{color:var(--warn);background:var(--warn-fill);border-color:var(--warn-bd)}
.badge--info,.badge-cold{color:var(--info);background:var(--info-fill);border-color:var(--info-bd)}
.badge--err {color:var(--err); background:var(--err-fill); border-color:var(--err-bd)}
.badge--muted{color:var(--text-dim);background:var(--line-faint);border-color:var(--border)}
.badge-hot {color:var(--err); background:var(--err-fill); border-color:var(--err-bd)}
.badge-warm{color:var(--warn);background:var(--warn-fill);border-color:var(--warn-bd)}
.badge .dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor}
```

### 2f. Chart container
```css
.chart-wrap{margin-top:.75rem;height:140px;position:relative}
.chart-wrap svg{width:100%;height:100%;display:block}
.chart-wrap--sm{height:64px}      /* inline / strip charts */
.chart-legend{display:flex;gap:var(--sp-3);flex-wrap:wrap;margin-top:.4rem;
  font:500 var(--fs-xs)/1 var(--font-sans);color:var(--text-dim)}
.chart-legend i{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:.3rem;vertical-align:-1px}
```

### 2g. Button
```css
.btn{display:inline-flex;align-items:center;gap:.4rem;
  padding:.4rem .75rem;font:600 var(--fs-sm)/1 var(--font-sans);
  border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;
  background:var(--card-2);color:var(--text);box-shadow:var(--ring-top);
  transition:background var(--t),border-color var(--t),transform var(--t-fast)}
.btn:hover{background:var(--card-hover);border-color:var(--border-strong)}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn-primary{color:#0a0c12;border-color:transparent;background:var(--brand-grad);box-shadow:var(--brand-glow)}
.btn-primary:hover{filter:brightness(1.07)}
.btn-danger{color:var(--err);border-color:var(--err-bd);background:var(--err-fill)}
.btn-danger:hover{background:rgba(240,98,91,.2)}
.btn--ghost{background:transparent;border-color:transparent;box-shadow:none;color:var(--text-dim)}
.btn--ghost:hover{background:var(--line-faint);color:var(--text)}
.btn--sm{font-size:var(--fs-xs);padding:.2rem .5rem}
```
Primary text `#0a0c12` clears AA across the whole gradient (4.9:1 on violet, 9.8:1 on cyan).

### 2h. Forms (sunken wells)
```css
.input,.select,.textarea{width:100%;padding:.45rem .6rem;border-radius:var(--r-xs);
  border:1px solid var(--border);background:var(--bg-elev);color:var(--text);
  font:var(--fs-md)/1.4 var(--font-sans);box-shadow:var(--inset-well);
  transition:border-color var(--t),box-shadow var(--t)}
.input:focus,.select:focus,.textarea:focus{border-color:var(--brand);
  box-shadow:var(--inset-well),0 0 0 3px var(--brand-wash);outline:none}
.textarea{resize:vertical}
.field{display:flex;flex-direction:column;gap:.25rem}
.field-label{font:600 var(--fs-xs)/1 var(--font-sans);text-transform:uppercase;
  letter-spacing:var(--tracking-cap);color:var(--text-dim)}
```
Use `.mono` on inputs that take IDs/paths.

### 2i. State system — loading / empty / error (today only `.empty-msg` exists)
```css
.skel{background:linear-gradient(90deg,var(--line-faint) 25%,rgba(255,255,255,.09) 37%,var(--line-faint) 63%);
  background-size:400% 100%;border-radius:var(--r-xs);animation:shimmer 1.4s ease infinite}
.skel--line{height:.8em;margin:.35rem 0} .skel--kpi{height:1.6rem;width:60%}
@keyframes shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}

.empty{display:flex;flex-direction:column;align-items:center;gap:.5rem;
  padding:var(--sp-6);color:var(--text-dim);text-align:center}
.empty .empty-icon{width:32px;height:32px;color:var(--text-mute)}
.empty .empty-title{font:600 var(--fs-md)/1 var(--font-sans);color:var(--text)}
.empty-msg{color:var(--text-dim);font-style:italic;font-size:var(--fs-sm);padding:1rem 0}  /* legacy alias kept */

.state-error{display:flex;gap:.6rem;align-items:flex-start;padding:var(--sp-4);
  border:1px solid var(--err-bd);background:var(--err-fill);border-radius:var(--r-sm);color:var(--text)}
.state-error .state-error-icon{color:var(--err);flex-shrink:0}
```
Rule: while a tab has not yet received its first SSE tick, KPI values render `.skel--kpi`; tables/feeds
render 3 `.skel--line` rows. Empty arrays render `.empty` (icon + title), never a bare dash. Error
states (e.g. `indexHealth` errors, LLM down) use `.state-error`.

### 2j. Bars (stacked / histogram / category / score) — dimensional
Keep existing classes; add a top-light gradient overlay and inter-segment dividers so bars read as
solid instrument indicators.
```css
.stacked-bar .seg, .hist-bar, .cat-row .cat-bar, .sr-seg{
  background-image:linear-gradient(rgba(255,255,255,.12),transparent)}
.stacked-bar{display:flex;height:24px;border-radius:var(--r-sm);overflow:hidden;margin-top:.5rem}
.stacked-bar .seg + .seg{box-shadow:inset 1px 0 0 var(--bg)}   /* hairline category divider */
.seg-hot{background:var(--err)} .seg-warm{background:var(--warn)} .seg-cold{background:var(--info)}
```

---

## 3. Charts — `assets/lib/charts.js` (no chart lib; pure SVG)

`viewBox` stays `0 0 600 140`; `preserveAspectRatio="none"` on existing SVGs distorts strokes, so all
strokes use `vector-effect="non-scaling-stroke"`. Keep the `drawChart(svgId, points, color)`
signature (back-compat — `points` is `[{y}]`, `color` is a CSS color/`var(--…)`). Add three helpers.

### 3a. `drawChart` — luminous area sparkline (upgrade in place)
```js
export function drawChart(svgId, points, color){
  const svg=document.getElementById(svgId); if(!svg||points.length<2){if(svg)svg.innerHTML='';return;}
  const w=600,h=140,pad=4, max=Math.max(1,...points.map(p=>p.y)), step=w/(points.length-1);
  const xy=points.map((p,i)=>[i*step, h-pad-(p.y/max)*(h-2*pad)]);
  const line=xy.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
  const area=line+' '+w.toFixed(1)+','+h+' 0,'+h;
  const gid=svgId+'-g';
  svg.innerHTML=
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">`+
    `<stop offset="0" stop-color="${color}" stop-opacity=".28"/>`+
    `<stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>`+
    `<line x1="0" y1="${h*.5}" x2="${w}" y2="${h*.5}" stroke="rgba(255,255,255,.05)"/>`+
    `<polygon points="${area}" fill="url(#${gid})"/>`+
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" `+
    `vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>`+
    `<circle cx="${xy[xy.length-1][0].toFixed(1)}" cy="${xy[xy.length-1][1].toFixed(1)}" r="3" fill="${color}"/>`;
}
```

### 3b. `drawBars(svgId, values, color, opts?)` — vertical mini-histogram (errors/min, auth/min, heat)
`values` = `number[]`. Renders gradient-topped rounded bars, optional median marker line
(`opts.median`). Reuses the same 600×140 viewBox; bar width = `w/values.length` with a 1px gap.
This backs the Logs / Rate-Limits per-minute spike sparklines (§5) and the heat histogram.

### 3c. `drawGauge(svgId, value01, opts?)` — bounded 0–1 arc (health, resolution %, temp balance)
Renders a 270° arc track (`--line-faint`) + a value arc. **Color comes from the threshold map**, not
brand: `value` mapped to `--ok/--warn/--err`. Center text is the formatted value/grade. **Gauges are
for bounded 0–100 indices only — never for unbounded counts.**

### 3d. `drawMulti(svgId, series, opts?)` — overlaid sparklines (dream health/themes/orphans/decayed)
`series` = `[{points:[{y}], color}]`, shared y-scale (or per-series via `opts.normalize`). Thin lines,
endpoint dots, no fill (legend lives in `.chart-legend` below the SVG). Backs Intelligence dream-history.

> Bars/stacked-bars that are pure CSS (`.cat-bar`, `.stacked-bar`, `.hf-bar`) stay CSS-driven — only
> the *value-history* visualizations move into `charts.js`. No tab inlines SVG construction anymore.

---

## 4. Information architecture — group the 8 tabs into 3 zones

Keep all 8 tabs; only **visually cluster** them. Add `group?: 'ops'|'knowledge'|'build'` to `TabDef`
in `tabs.ts`. `renderPage()` in `layout.ts` renders each cluster inside
`<div class="tab-group" role="group" aria-label="Operations">` with a tiny uppercase caption.
`core.js` `switchTab`/`wireTabBar` are unchanged (still select by `data-tab`).

```
OPERATIONS               KNOWLEDGE            BUILD
Overview · Sessions      Vault & Memory       Agents
Rate Limits · Logs       Intelligence         Code
```
- **Operations** = live request/runtime plane (who's hitting the server, is it behaving).
- **Knowledge** = vault/AI plane (they share `memoryTemperature`, `healthScore`, dream lifecycle).
- **Build** = developer-asset plane (agents/teams/skills, code-nav) — distinct audience.

```css
.tab-bar{background:var(--bg-elev);border-bottom:1px solid var(--border);padding:0 var(--sp-5);
  display:flex;align-items:flex-end;gap:var(--sp-5);overflow-x:auto}
.tab-group{display:flex;align-items:flex-end;gap:.15rem;position:relative}
.tab-group + .tab-group{padding-left:var(--sp-5);border-left:1px solid var(--border)}
.tab-group-label{position:absolute;top:-.1rem;left:.6rem;font:600 var(--fs-xs)/1 var(--font-sans);
  text-transform:uppercase;letter-spacing:var(--tracking-cap);color:var(--text-faint)}
```
(If the label row crowds on narrow widths, drop `.tab-group-label` below 720px via media query and
keep the `border-left` separators — the clustering still reads.)

---

## 5. Per-tab direction

### TAB 1 — Overview (the flagship; full rebuild into 4 bands)
Today Overview only answers "is the MCP busy?" The redesign makes it the **executive summary**:
*alive? → headline KPIs → what needs me? → operational detail.* All values come from existing
payload fields (or `derived`, §7); every promoted tile **deep-links** to its detail tab
(`.card--kpi.is-link`, click → `switchTab`).

Grid: introduce a 12-col alias so bands aren't forced into equal quarters.
```css
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:var(--gutter);margin-bottom:var(--sp-4)}
.col-2{grid-column:span 2}.col-3{grid-column:span 3}.col-4{grid-column:span 4}
.col-6{grid-column:span 6}.col-8{grid-column:span 8}.col-12{grid-column:span 12}
@media(max-width:900px){[class*=col-]{grid-column:1/-1}}
```
(`row-N` stays for the simple cases — most other tabs keep using it.)

**Band A — System Status strip** (`col-12`, NEW): one thin row of `statusPill()` buttons answering
"is everything up?" — the cross-tab roll-up that exists nowhere today. Each pill is a real `<button>`
that switches to the relevant tab.

| Pill | Source | State |
|---|---|---|
| MCP / SSE | `body[data-sse]` | online / reconnecting |
| Local LLM | `llmStatus.{configured,available}` | up / not-configured / down → Intelligence |
| Embeddings | `embeddingStats` | ready / loading → Vault |
| Search Index | `indexHealth` | clean / errors → Vault |
| Vault Health | `healthScore.grade` | A→F color band → Intelligence |

**Band B — KPI scorecards** (two `.grid` rows of `.col-3 .card--kpi`). Each = label + big sans value
+ status pill + delta chip + (where history exists) `.kpi-spark`. The 8 headline numbers an
operator/owner checks first:

1. **MCP Requests** — `mcpRequests` + `rpm` req/min + `requestBreakdown`; spark from
   `derived.rpmSeries` (per-sample `latencyHistory[].requestCount`); delta vs 10-min ago.
2. **Error Rate %** — `derived.errorRatePct` = `errorResponses/totalRequests` (the *rate* is the KPI,
   the raw count is the sub). Pill: ok `<1%`, warn `1–5%`, bad `>5%`. → Logs.
3. **Latency Health** — avg-latency spark (`latencyHistory[].avgLatencyMs`) + `derived.latencyTailRatio`
   (request-weighted p95÷avg over `toolCalls`); pill bad when `>3`. → Overview detail (Band D).
4. **Vault Health** — `healthScore.score`/`.grade` (PROMOTED from Intelligence — the flagship metric),
   compact grade chip; spark from `derived.healthTrend` over `dreamHistory[].healthScore`. → Intelligence.
5. **Active Sessions** — `sessions.length` + `derived.activeSessions` (live in last 60s) split. → Sessions.
6. **Memory Temperature** — compact `.stacked-bar` (`memoryTemperature.hot/warm/cold`). → Vault.
7. **Code-Nav Savings** — `codeNavSavings` cumulative total (PROMOTED — headline ROI); spark from
   `codeNavSavings.history[].cumulativeSaved`. → Code.
8. **Indexed Notes** — `indexedNotes` + embedding-coverage sub (`derived.embeddingCoverage`). → Vault.

**Band C — Attention feed** (`col-8` / `col-4` split): only *actionable/anomalous* items; empty
states collapse (no green wall).
- Recent Errors & Auth Failures — top 3–5 from `recentErrors` + `recentAuthFailures` → "View in Logs".
- Rate-Limited IPs — any `rateLimits` entry with `remaining===0` → "View in Rate Limits".
- AI Recommendations — count + top 2 from `lastDream.connectionSuggestions`/`consolidationGroups` → Intelligence.
- Orphan Memories — count from `lastDream.orphans` → Intelligence.

**Band D — operational detail (demoted, below the fold):** keep Requests/min + Avg-Latency charts
(`#chartRpm`, `#chartLatency`) and the Tool Usage table (`#toolTableBody`) **exactly as-is** (ids and
`overview.js` untouched). Enhance the table: add a derived **error-rate** column (`errors/count`) with
a status dot, and a tiny avg-latency bar relative to the slowest tool. "So what?" strip at top of Band D.

### TAB 2 — Sessions
Today: one raw table. Add a header **summary strip** (3 `.card--kpi`):
- **Active vs idle** — from `derived` over `sessions[].lastActivity` (active <60s).
- **Request concentration** — `derived.topSessionShare` = `max(requestCount)/sum` (one session at
  80% is an operational risk a sorted table hides).
- **Fleet workload mix** — aggregate `toolCounts` across sessions → `.stacked-bar` of top tools.

Per row: relative **idle indicator** (timestamp + dot) instead of raw epoch; `lastTools` rendered as
a left→right chip sequence (recency pattern is the signal); top-3 `toolCounts` as a sparbar.
**So what:** "6 sessions, 2 active; top session = 71% of requests; fleet is 60% code-search."

### TAB 3 — Rate Limits
The data is **auth-failure throttling**, not capacity — frame it as *security*. Header strip:
- **IPs throttled now** — count where `remaining===0` (the alarm).
- **Suspicious IPs** — `derived.suspiciousIps`: join throttle keys with `recentAuthFailures` by IP
  (same IP in both = active brute-force).
- **Auth-failure rate** — `drawBars` sparkline bucketing `recentAuthFailures[].timestamp` per minute.

Per row: a **countdown bar to `resetAt`** (time-remaining proportion) instead of a raw epoch; row
colored/iconed by `remaining` (0 = throttled). **So what:** "2 IPs throttled; IP X = 14 auth failures
in 5 min — likely attack."

### TAB 4 — Vault & Memory (densest tab — impose in-tab disclosure + promote 3–4 KPIs)
No new tabs; reorganize the ~16 cards under three `sectionHead` zones, wrapping the deep block in a
native `<details>` (zero JS, keyboard-accessible):
1. **Index & Admin** (top): vaults table, add-vault form, rebuild, migration (write actions).
2. **Memory & Search (live)**: temperature, semantic search, memory stack L0/L1, search quality, recent searches.
3. **Analytics (deep, collapsible)**: temp-over-time, heat histogram, top notes, categories,
   collections, score breakdowns, vault health, link density, search analytics, lifecycle, benchmarks.

Promote 3–4 KPIs to the top, demote the rest to drill-down:
- **Retrieval quality** — `derived.zeroResultRate` = `searchStats.zeroResultCount/totalSearches` (the
  vault's one job); pair with `derived.searchLatencyP50/P95` from `recentSearches[].latencyMs`.
- **Hybrid balance** — diverging proportion bar of `searchTypeStats.avgLexicalContribution` vs
  `avgSemanticContribution`; plus `lexicalOnlyHits/semanticOnlyHits/bothHits` complementarity (high
  "both" = healthy fusion).
- **Temp balance** — reuse `computeTempBalance` → `drawGauge` (0–1) with its Δ over `temperatureHistory`.
- **Stale/orphan ratios** — `derived.staleRatio` (`vaultHealth.staleNotes/totalFiles`),
  `derived.orphanRatio` (`linkDensity.orphanNotes/totalMdFiles`), `derived.embeddingCoverage`
  (`embeddingStats.vectors/indexedNotes`) — all as % with threshold pills.

Viz: **wire the benchmark card** (currently TODO/`&mdash;` placeholders) to
`benchmarkSummary.avgRecallAt5/avgNdcgAt10/totalLatencyMs/timestamp`; add a per-query dot-plot of
`results[].ndcgAt10` (variance, not just the average). Heat histogram + median marker via `drawBars`.
Cap collections/categories to top-N + "other". **So what:** "Zero-result 6% (good); 88% both-retriever
hits; embedding coverage 73% — 412 notes unembedded."

### TAB 5 — Intelligence (already the most insight-shaped; lean in)
- **Health score + trend** — keep the arc (`drawGauge`); add `derived.healthTrend` from
  `dreamHistory[].healthScore` next to it (a falling B+ is the story).
- **Factor waterfall** — replace the flat `healthFactors` list with a contribution bar chart from
  `healthScore.factors[]` showing each factor's points + **gap to max** (`weight*100 - contribution`)
  → "link density is your biggest lever."
- **Entity quality** — `derived.entityConfirmationRate` = `confirmed/total` headline over the existing
  tier stacked bar; `derived.kgDensity` = `triples/entities` (graph richness).
- Dream-history → `drawMulti` (health/themes/orphans/**decayed**) with legend.
- KG predicates → horizontal proportion bars (the relation-vocabulary shape is the insight).
- `derived.dreamCadence` (avg interval between `dreamHistory[].timestamp`) → "are dreams running or stale?"

**So what:** "Health B+ (78) but ↓6 over 4 dreams — link density limiting; entity confirmation 31% (noisy)."

### TAB 6 — Agents
Add an **activity summary strip** above the 3 roster tables (which stay as reference data):
- `derived.agentsActive24h`, busiest agent (max `entryCount`), dormant count (old `lastActive`).
- `derived.agentsDefinedNeverRun` — set-difference of roster vs `agentDiaries` (config hygiene).
- `entryCount` per agent → ranking bar ("most active agents").
Diary entries → timeline feed (already feed-shaped). **So what:** "4/9 agents active in 24h;
research-agent busiest (212 entries); 2 defined but never run."

### TAB 7 — Code (token-savings — the product ROI thesis)
- **Cumulative savings + run-rate** — replace the text placeholder `#codeSavingsChart` with a real
  `drawChart` area from `codeNavSavings.history[]`; headline `derived.savingsRunRate` (Δ cumulative ÷ Δ ts).
- **Avg saved / call** — `derived.savingsPerCall` = `totalSaved/totalCalls` as a fleet KPI.
- **Call resolution %** — `derived.callResolutionPct` = `resolved/(resolved+unresolved)` → `drawGauge`
  (index-quality; low = dangling symbol graph).
- By-tool savings → horizontal bars ranked by `totalSaved` (Pareto); keep table as drill-down.
- Per-repo: relative **last-indexed** time + stale dot from `perRepo[].lastIndexedAt`;
  `derived.symbolsPerFile` density. **So what:** "Saved 1.2M tokens (~340k/day, rising); 91% resolution; repo-x 9d stale."

### TAB 8 — Logs
Keep the feeds (drill-down); add a **header summary strip**:
- **Errors/min** — `drawBars` sparkline bucketing `systemLogs`+`recentErrors` by minute (a spike is
  the signal a scrolling feed hides).
- **Top error signatures** — `derived.topErrors`: group `recentErrors[].message` (+ `recentToolCalls`
  where `status==='error'`) by tool/message prefix → "top 3 recurring ×N" ("1 problem ×50", not 50 lines).
- **Tool success rate (live)** — rolling ok/error ratio over `recentToolCalls[].status`.
- Auth-failures: reuse the **same** per-minute bucket sparkline as Rate Limits (compute once in
  `derived`, consume in both). **So what:** "Error rate flat (3/min); top issue embeddings:timeout ×27."

---

## 6. Header chrome + identity (`layout.ts` + `app.css`)
```css
.header{padding:var(--sp-3) var(--sp-5);background:linear-gradient(180deg,var(--card),var(--bg-elev));
  border-bottom:1px solid var(--border);box-shadow:0 1px 0 rgba(255,255,255,.03),var(--shadow-1)}
.header h1 .brand{font-weight:700;letter-spacing:-.03em;
  background:var(--brand-grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.status-dot{position:relative;background:var(--ok)}
.status-dot::after{content:"";position:absolute;inset:0;border-radius:50%;
  animation:ping 2.2s cubic-bezier(0,0,.2,1) infinite}
@keyframes ping{0%{box-shadow:0 0 0 0 rgba(70,194,102,.5)}80%,100%{box-shadow:0 0 0 7px rgba(70,194,102,0)}}
body[data-sse="reconnecting"] .status-dot{background:var(--warn)}
.tab-btn{padding:.65rem 1rem;color:var(--text-dim);position:relative;background:none;border:none;
  border-bottom:2px solid transparent;display:inline-flex;align-items:center;gap:.45rem;cursor:pointer;white-space:nowrap}
.tab-btn:hover{color:var(--text)}
.tab-btn.active{color:var(--text)}
.tab-btn.active::after{content:"";position:absolute;left:.6rem;right:.6rem;bottom:-1px;height:2px;
  border-radius:2px;background:var(--brand-grad)}   /* spectral underline */
```
Header additions (all `core.js`-local, single-EventSource preserved):
1. **Connection label** — text "Online"/"Reconnecting…" next to the dot, swapped purely by
   `body[data-sse]` in CSS; wrap in `aria-live="polite"`.
2. **Last-update age** — `#lastUpdate` ("updated 2s ago"), ticked from the SSE `onmessage` timestamp
   on the existing 1s clock interval (one variable). The freshness trust signal.
3. **Manual refresh** — small button: `es.close(); connectSse()`.
4. **Health chip** — mirror `healthScore.grade` as a tiny colored chip in `.status-group` so the
   flagship metric is visible from every tab.

Identity lives in two near-free moves: the **gradient-clipped wordmark** and the **spectral
active-tab underline**. That plus the rationed brand usage is what reads as "a specific product."

---

## 7. Derived signals — `model/derive.ts` (the only server-logic addition)
Compute once per SSE tick in `payload.ts` and attach under a `derived` namespace
(`payload.derived = computeDerived(payload)`), keeping every existing field untouched and the
single-EventSource model intact. Tabs read `ctx.data.derived.*`. All inputs are already-capped arrays
(≤360 latency/temp, ≤50 recent buffers, ≤30 searches), so this is O(payload). Pattern follows the
existing pure helpers in `model/health.ts`.

Helpers:
- `ratio(n,d)` → `n/max(d,1)`.
- `trend(points)` → sign of least-squares slope over last N → `'up'|'down'|'flat'` + `pct` Δ.
- `bucketPerMinute(timestamps, windowMin)` → `number[]` for `drawBars` (shared by Logs + Rate Limits).
- `weightedRatio(items, num, den, weight)` → for `latencyTailRatio`.

Signals (grouped by tab): `errorRatePct, rpmSeries, rpmTrend, latencyTailRatio, requestMix` ·
`activeSessions, topSessionShare, fleetToolMix` · `throttledNow, suspiciousIps, authFailPerMin` ·
`zeroResultRate, searchLatencyP50/P95, embeddingCoverage, tempBalanceIndex(+Δ), staleRatio,
orphanRatio` · `healthTrend, orphanTrend, entityConfirmationRate, kgDensity, dreamCadence` ·
`agentsActive24h, agentsDefinedNeverRun, busiestAgent` · `savingsPerCall, savingsRunRate,
callResolutionPct, symbolsPerFile, perRepoStale[]` · `errPerMin, topErrors, toolSuccessRate`.

**Threshold map** — a single exported config object (`THRESHOLDS`) maps each signal to
`{good, warn}` cutoffs and a `direction` (higher-better vs lower-better), plus a `pillState(value,
key)` helper returning `'ok'|'warn'|'bad'`. This makes good/warn/bad **consistent and auditable**
across all tabs (the client passes the value + key, never hard-codes a color).

---

## 8. Accessibility (WCAG AA — mandatory)
- **Tabs ARIA:** tab bar `role="tablist"`; buttons `role="tab"` + `aria-selected` + roving `tabindex`;
  panels `role="tabpanel"` + `aria-labelledby`; arrow-key nav. Add the attrs in `core.js switchTab`
  (the `.active` toggle already exists) + mark active tab `aria-current="page"`.
- **Skip link** before the tab bar in `layout.ts`: `<a class="skip" href="#main">Skip to content</a>`
  (off-screen-until-focus); `.content` gets `id="main" tabindex="-1"`.
- **Real controls:** status pills / KPI deep-links are `<button>`/`<a>` (focusable, keyboard), never
  click-handlered `<div>`s. `#toastContainer` and the connection label get `aria-live="polite"`.
- **Never color-only:** every pill/badge/delta carries a glyph or text label (↑/↓/→, "Hot: 0",
  ok/error glyph) in addition to the token color. Status dots get `aria-label`.
- **Focus ring:** `:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:var(--r-xs)}`;
  on the gradient primary button use `outline-color:#fff;outline-offset:3px` for contrast.
- **Contrast:** all text/bg pairs in §1 are ≥4.5:1 (body) / ≥3:1 (large); `--text-faint`/`--text-mute`
  are fenced (comment in file) to large or decorative use only.
- **Hit targets:** `.tab-btn` (.65rem pad + 13px) and `.btn--sm` clear the ≥24px AA box.
- **Reduced motion (mandatory):**
  ```css
  @media(prefers-reduced-motion:reduce){
    *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;
      transition-duration:.001ms!important}
    .status-dot::after,.dream-running,.skel{animation:none}
  }
  ```

### Motion (signature, all behind reduced-motion)
```css
@keyframes flash{0%{background:var(--brand-wash);box-shadow:inset 0 0 0 1px rgba(139,125,255,.4)}
  100%{background:transparent;box-shadow:none}}
.flash{animation:flash .9s var(--ease)}
.tab-panel.active{animation:panelIn .26s var(--ease)}
@keyframes panelIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
```
`.flash` answers "what just changed?" on a live console: `core.js` adds the class to a value node on
SSE update (it already touches these nodes) and a `transitionend`/timeout removes it.

---

## 9. Build order (low-risk → high-impact; bump `ASSET_VERSION` per phase)
1. **Token swap** — replace `:root` + add legacy aliases (§1). Instant restyle of all 8 tabs, **zero
   JS/HTML edits**. Clears most of the "generic" gap alone.
2. **Component layer** — card/table/badge/button/form/state/bar rules (§2); add `.grid`/`.col-*`.
3. **Components helpers** — `kpi()`, `statusPill()`, `deltaChip()`, `sparkRow()`, `emptyState()` in
   `components.ts`.
4. **Charts** — `drawChart` upgrade + `drawBars`/`drawGauge`/`drawMulti` (§3).
5. **Header + identity** — gradient wordmark, spectral underline, connection label, last-update age,
   refresh, health chip, ARIA, skip link (§6, §8).
6. **Derived model** — `model/derive.ts` + `THRESHOLDS` + wire into `payload.ts` (§7).
7. **Overview rebuild** — bands A–D (§5 TAB 1); extend `overview.js` to fill new ids + deep-links.
8. **Tab grouping** — `TabDef.group` + grouped render (§4).
9. **Per-tab insight strips** — Sessions → Logs (§5), consuming `derived.*`; section-ize Vault with
   `<details>`.

Each phase is independently shippable; none touches the SSE contract or adds a dependency.
