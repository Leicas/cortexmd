# cortexmd Dashboard — MVC Split + UX Refresh (Architecture)

> Status: **design only**. This document is the implementation contract. Engineers should
> be able to build each piece in parallel without re-deciding structure, naming, or interfaces.
>
> Scope: structural refactor of the 3.4k-line `src/dashboard.ts` monolith into small MVC
> modules under `src/dashboard/`, plus a **visual** UX refresh. Same 8 tabs, same data, same
> endpoints. **No** information-architecture redesign. **No** new npm deps. **No** bundler /
> build step beyond `tsc`. Strict-TS ESM, Node 22, Express 5, `.js` import extensions.

---

## 0. Source of truth — what exists today

`src/dashboard.ts` currently contains four concerns welded together:

1. **Controller** — `dashboardRouter` (Express `Router`) with ~15 route handlers:
   - POST admin actions: `/dashboard/api/rate-limit/reset`, `…/reset-all`,
     `/dashboard/api/sessions/kill`, `/dashboard/api/benchmark/run`,
     `…/benchmark/save-ground-truth`, `/dashboard/api/index/rebuild`,
     `/dashboard/api/kg/bootstrap`, `/dashboard/api/migrate/dry-run`, `…/migrate/run`,
     `/dashboard/api/dream/run`, `…/dream/dismiss`.
   - GET data/JSON: `/dashboard/api/dream/history`, `/dashboard/api/llm/status`,
     `/dashboard/api/agents`, `/dashboard/api/teams`, `/dashboard/api/skills`,
     `/dashboard/api/agent-diary/:name`.
   - GET SSE: `/dashboard/events` (single 2s `setInterval` push of a giant `payload`).
   - GET page: `/dashboard` → `res.type('html').send(DASHBOARD_HTML)`.
2. **Model logic** — `computeHealthScore`, `computeTempBalance`, the SSE payload assembly
   (which fans out to `getMetrics`, `getRateLimitSnapshot`, `getSessionSnapshots`,
   `getOAuthClients`, `getDocMeta`/`getDocMetaSummary`, `getCollectionDistribution`,
   `getEmbeddingStats`, `getRecentLogs`, `getRecentSearchScores`, `getBenchmarkResults`,
   `getIndexHealth`, `wakeUp`, `kgStats`, `listEntities`, `listAgents`, dream history,
   LLM health probing), and the in-module mutable state (`dreamHistory`, `lastDreamReport`,
   `dreamRunning`, `llmStatus`, `dismissedSuggestions`, `memoryStackCache`, `agentDiaryCache`).
3. **View** — one `DASHBOARD_HTML` template literal: `<head>` + inline `<style>` (~270 lines)
   + `.shell`/`.header`/`.tab-bar` + 8 `.tab-panel` markup blocks + inline `<script>`.
4. **Client JS** — ~1700 lines inside the inline `<script>`: state, fmt/esc helpers, toast,
   `postAction`, source-vault CRUD, `switchTab`, `drawChart`, one `render<Tab>()` per tab,
   `renderCurrentTab()` dispatch, clock, and the `EventSource('/dashboard/events')` loop.

Mounting (`src/index.ts`): `app.use('/dashboard', dashboardAuthMiddleware)` then
`app.use(dashboardRouter)`. `dashboardAuthMiddleware` only guards the `/dashboard` path
prefix. **The new static asset routes live under `/dashboard/assets/**`, so they are
automatically behind the existing auth gate — no index.ts change required.** The login page
(`src/index.ts`) already says `cortexmd dashboard`; only the dashboard `<title>`/`<h1>` are
stale (`Obsidian MCP — Control Panel`).

### Cross-cutting facts the implementation MUST preserve

- **SSE is the data spine.** Every tab except Agents (`/dashboard/api/agents|teams|skills`)
  and Agent-diary (`/dashboard/api/agent-diary/:name`) and source-vaults
  (`/api/source-vaults`) renders purely from the single SSE `payload`. The split must keep a
  **single** `EventSource` connection feeding **all** tab modules — do not open one stream
  per tab.
- `data.codeNav` and `data.codeNavSavings` arrive via the `...getMetrics()` spread, not via
  explicit assignment. Preserve the spread.
- Some payload pieces are **async-cached** across pushes (`memoryStackCache`,
  `agentDiaryCache`) — that caching is model state and moves into `model/`, not the view.
- `renderLogs` lazily wires filter listeners once (`renderLogs._filtersWired`). `renderAgents`
  lazily fetches via `fetchAgentsData` and guards with `agentsLoaded`. `switchTab('vault')`
  triggers `loadSourceVaults()`. These lifecycle quirks become the formal `init()`/`refresh()`
  contract (§4/§5).
- Client JS is **ES5-style** (`var`, `function`, no modules) and HTML-escapes via a detached
  DOM node (`esc`). The refactor moves to native ES modules (`type="module"`) — keep the same
  escaping semantics.
- Tool-table sorting state (`sortCol`/`sortDir`) and per-th click wiring belong to the
  Overview tab module, not the core.

---

## 1. File tree under `src/dashboard/`

```
src/dashboard/
  ARCHITECTURE.md            ← this doc

  index.ts                   ← re-exports { dashboardRouter } (keeps src/index.ts import stable:
                                 `import { dashboardRouter } from './dashboard.js'` becomes
                                 `from './dashboard/index.js'`; or keep a thin src/dashboard.ts
                                 shim — see §6 migration)

  controller.ts              ← THE CONTROLLER. Builds & exports `dashboardRouter` (express.Router).
                                 Mounts: page route, asset routes, SSE route, action routes,
                                 data (GET json) routes. Each handler is thin: validate → call a
                                 model fn → res.json. Delegates HTML to views/, payload to model/.

  routes/                    ← route-group registrars, each takes the Router and attaches handlers
    actions.ts               ←   POST admin actions (rate-limit reset/-all, sessions/kill,
                                 benchmark run/save-ground-truth, index/rebuild, kg/bootstrap,
                                 migrate/dry-run|run, dream/run, dream/dismiss)
    data.ts                  ←   GET json (dream/history, llm/status, agents, teams, skills,
                                 agent-diary/:name)
    sse.ts                   ←   GET /dashboard/events (SSE; builds payload via model/payload.ts)
    page.ts                  ←   GET /dashboard → renderPage() ; GET /dashboard/assets/* static

  model/                     ← DATA: fetch + serialize per concern. No HTML. No Express types
                                 leaking past function boundaries (handlers pass primitives in).
    state.ts                 ←   module-singleton mutable state: dreamHistory, lastDreamReport,
                                 dreamRunning flag, llmStatus, dismissedSuggestions,
                                 memoryStackCache, agentDiaryCache. Exposes typed getters/setters.
    health.ts                ←   computeHealthScore(), computeTempBalance() (pure)
    payload.ts               ←   buildSsePayload(): assembles the full SSE object from the
                                 sources below. This is the de-facto "view-model" for all tabs.
    metrics.ts               ←   wraps getMetrics + percentile enrichment of toolCalls
    sessions.ts              ←   getSessionSnapshots, getRateLimitSnapshot, getOAuthClients
    vault.ts                 ←   docMeta temperature counts, getDocMetaSummary,
                                 getCollectionDistribution, getEmbeddingStats, getIndexHealth,
                                 wakeUp() memory-stack cache, search-score breakdowns, benchmark
    intelligence.ts          ←   dream report shaping (orphans/themes/connections filtered by
                                 dismissedSuggestions), kgStats, listEntities → entityStats,
                                 dream history summary, llm health probe (throttled)
    agents.ts                ←   listAgentDefs/listTeams/listSkills, listAgents → agentDiaryCache,
                                 readAgentDiary
    dream.ts                 ←   runDreamCycle orchestration incl. optional LLM consolidation
                                 (the big POST /dream/run body), pushes into state.dreamHistory
    logs.ts                  ←   getRecentLogs passthrough/shaping

  payload.types.ts           ← `DashboardPayload` interface + all per-tab sub-interfaces
                                 (ToolCallStat, SessionSnapshot, RateLimitRow, VaultPayload,
                                 IntelligencePayload, AgentsPayload, CodeNavPayload, LogsPayload…).
                                 SHARED between server (model) and—as the contract reference—the
                                 client modules' JSDoc. Single source of payload truth.

  views/
    layout.ts                ←   renderPage(): doctype, <head> (title=cortexmd, viewport,
                                 <link rel=stylesheet href=/dashboard/assets/app.css>),
                                 header (brand+status+logout), tab-bar (from TAB registry §4),
                                 .content with each tab's server fragment, footer,
                                 toast container, <script type="module" src=/dashboard/assets/app.js>.
                                 Composes tabs from the TABS registry — never hardcodes 8 blocks.
    tabs.ts                  ←   TAB registry: ordered array of TabDef (§4). Single list the
                                 layout + tab-bar + client core all derive from.
    components.ts            ←   server-side HTML component helpers (card(), sectionTitle(),
                                 tableWrap(), btn(), badge(), row(n)) returning HTML strings.
                                 Used by tab fragments to cut markup duplication. Pure functions.
    tabs/
      overview.ts            ←   renderOverviewTab(): HTML fragment string for #tab-overview
      sessions.ts
      ratelimits.ts
      vault.ts
      intelligence.ts
      agents.ts
      code.ts
      logs.ts

  assets/                    ← STATIC files served verbatim (no transform). See §2.
    app.css                  ←   the extracted global stylesheet (design tokens §5 + components)
    core.js                  ←   client core ES module: state, EventSource loop, tab switching,
                                 fetch helpers, fmt/esc/format utils, toast, postAction, the
                                 TAB registry mirror + dispatch. Exports nothing to global except
                                 a small `window.cortex` action namespace for inline onclick (§3).
    app.js                   ←   entry ES module: `import { boot } from './core.js'` + imports the
                                 8 tab modules, registers them, calls boot().
    tabs/
      overview.js            ←   client tab module (init/refresh contract §3/§4)
      sessions.js
      ratelimits.js
      vault.js
      intelligence.js
      agents.js
      code.js
      logs.js
    lib/
      dom.js                 ←   $(id), esc, escAttr, setText, html helpers (shared by tabs)
      fmt.js                 ←   fmt, fmtMs, fmtUptime, fmtTime, fmtAgo, fmtDate, fmtBytes,
                                 latClass, truncate (the formatting utils, extracted verbatim)
      charts.js              ←   drawChart (sparkline) + stacked-area + gauge helpers
```

> **Why `.js` source files in `assets/`** (not `.ts`): there is no bundler/transpile step for
> client code, and `tsc` compiles only the server. Authoring client modules as `.js` keeps them
> servable as-is. Type-safety for client code is provided by JSDoc `@typedef` referencing the
> shapes documented in `payload.types.ts` (copied as a JSDoc comment block at the top of
> `core.js`), and optionally `// @ts-check` per file (checked ad-hoc, not in the build). The
> server `model/payload.ts` return type is the authoritative `DashboardPayload`.

### Approximate sizes (target ceilings)

| Module group | files | each ~LOC |
| --- | --- | --- |
| controller + routes | 5 | 40–120 |
| model/* | 11 | 30–180 (dream.ts is the big one ~180) |
| views/layout+components+tabs.ts | 3 | 40–120 |
| views/tabs/*.ts | 8 | 30–110 (vault largest) |
| assets/lib/*.js | 3 | 40–90 |
| assets/core.js + app.js | 2 | 120 / 25 |
| assets/tabs/*.js | 8 | 40–260 (vault/intelligence largest) |

No single file should exceed ~280 LOC. If `vault.js` or `intelligence.js` does, split a
sub-render (e.g. `vault.benchmarks.js`) imported by the tab module — but keep the tab's public
`init/refresh` contract intact.

---

## 2. Asset serving (no bundler, native files)

### Page → assets flow

- `GET /dashboard` returns HTML from `views/layout.ts#renderPage()`. The `<head>` links
  `/dashboard/assets/app.css`; the end of `<body>` loads
  `<script type="module" src="/dashboard/assets/app.js"></script>`.
- `app.js` is an ES module; its `import './core.js'`, `import './lib/fmt.js'`,
  `import './tabs/overview.js'` etc. resolve as **relative URLs** that the browser fetches from
  `/dashboard/assets/...`. Native ESM, zero bundling. All client imports MUST use explicit
  `.js` extensions and relative paths (browser requirement, also matches server ESM style).

### Static route (`routes/page.ts`)

Serve the `assets/` directory. **Do not** add `express.static` of a build dir (no build); the
client `assets/` live in source and are present at runtime next to the compiled server only if
copied. Two acceptable implementations — pick **Option A**:

- **Option A (recommended, zero-config, no copy step): inline asset registry.**
  Read the asset files once at module load via `readFileSync(new URL('../assets/<f>', import.meta.url))`
  and register a small route table mapping URL → { body, contentType }. This keeps assets in
  `src/dashboard/assets/` and avoids a `dist/` copy step or `tsconfig`/package `files` changes.
  `import.meta.url` resolves to the compiled `dist/.../routes/page.js` location, so the asset
  path must be relative to the **compiled** layout. To keep `dist` and `src` layouts identical,
  add `assets/**` to the existing build copy (see §6) **or** resolve from a known base. Given
  "no build step changes" is preferred, Option A reads from a path computed off `import.meta.url`
  and REQUIRES the assets be copied to `dist` — so:

- **Option B (also acceptable, explicit): `express.static`.**
  `pageRouter.use('/dashboard/assets', express.static(assetsDir, { immutable:false, maxAge:'0', etag:true }))`
  where `assetsDir = fileURLToPath(new URL('../assets', import.meta.url))`. Express 5 ships
  `express.static` (serve-static) with **no new dep**. Same `dist` copy requirement.

Either way the **one** build concern is: the `assets/` tree must exist at the path the server
resolves at runtime. Resolve it from `import.meta.url` (see §6 for the single `package.json`
`build` script tweak to copy `src/dashboard/assets` → `dist/dashboard/assets`). This is the
only allowed build change and it is a `cp`, not a bundler.

### MIME + cache headers

- `app.css` → `Content-Type: text/css; charset=utf-8`
- `*.js` → `Content-Type: text/javascript; charset=utf-8` (**must** be a JS MIME or the
  browser refuses `type="module"`)
- Cache: assets are versioned by a short build/version string. Append `?v=<version>` to the
  `<link>`/`<script>` URLs in `renderPage()` (version pulled from `config` or `package.json`
  version, already importable). Serve with
  `Cache-Control: public, max-age=3600` (Option A: set manually; Option B: `maxAge` + rely on
  the `?v=` query to bust on deploy). SSE route keeps its existing `no-cache`.
- Auth: covered for free — `/dashboard/assets/**` is under the `/dashboard` prefix already
  guarded by `app.use('/dashboard', dashboardAuthMiddleware)` in `index.ts`. Confirm the
  asset route is registered on `dashboardRouter` (which is mounted after that middleware), not
  on `app` before it.

---

## 3. Client JS module pattern

### Core (`assets/core.js`)

Owns everything cross-tab. Exports a `boot()` entry and a tab-registration API; keeps a single
`EventSource`.

```js
// assets/core.js  (ES module, no build)
import { $, esc, escAttr } from './lib/dom.js';
import * as fmt from './lib/fmt.js';
import * as charts from './lib/charts.js';

const tabs = new Map();           // id -> TabModule
let activeTab = 'overview';
let data = {};                    // latest SSE payload (the DashboardPayload)
const inited = new Set();         // tabs whose init() has run

export function registerTab(mod) { tabs.set(mod.id, mod); }

export const ctx = {              // passed to every tab init/refresh
  get data() { return data; },    // live payload getter
  $, esc, escAttr, fmt, charts,
  toast, postAction, on, fetchJson,
};

export function boot() {
  wireTabBar();                   // clicks -> switchTab
  startClock();
  connectSse();                   // single EventSource('/dashboard/events')
  switchTab(activeTab);           // activates default tab (runs init+refresh)
}

function switchTab(id) {
  activeTab = id;
  // toggle .active on .tab-btn and .tab-panel (same DOM as today)
  const mod = tabs.get(id);
  const el = $('tab-' + id);
  if (mod && !inited.has(id)) { mod.init?.(el, ctx); inited.add(id); }
  mod?.refresh?.(el, ctx);
}

function connectSse() {
  const es = new EventSource('/dashboard/events');
  es.onmessage = (ev) => {
    try {
      data = JSON.parse(ev.data);
      $('uptime').textContent = fmt.fmtUptime(data.uptime); // header always
      tabs.get(activeTab)?.refresh?.($('tab-'+activeTab), ctx); // only active tab
    } catch (e) { console.error('payload parse', e); }
  };
  es.onerror = () => { es.close(); setTimeout(connectSse, 3000); };
}
```

Core also provides the shared helpers tabs need:

- `fetchJson(url, opts)` — wraps `fetch().then(r=>r.json())`.
- `postAction(url, body)` — POST + toast on `{ok}`/`{error}` (the existing `window.postAction`).
- `toast(msg, type)` — the existing toast.
- `on(el, evt, fn)` — thin add-listener helper.
- `$`, `esc`, `escAttr` re-exported from `lib/dom.js`.
- `fmt.*`, `charts.*` namespaces.

### Inline `onclick` migration

Today server-rendered rows use inline `onclick="killSessionAction('…')"`, `postAction(...)`,
`dismissRec(...)`, `loadSourceVaults()`, etc. With ES modules these globals disappear. Two
rules:

1. The core exposes a **single** namespaced global for the handful of action callbacks that
   server-rendered HTML strings reference: `window.cortex = { kill, resetRl, dismissRec,
   postAction, loadSourceVaults, addSourceVault, removeSourceVault, runMigration, runDream,
   copyLogLine, … }`. Tab modules register their action callbacks into `window.cortex` in their
   `init()`. HTML strings call `cortex.kill('…')`.
2. Prefer **event delegation** for new code: a tab's `init(el)` attaches one delegated listener
   on its panel (`el.addEventListener('click', e => { const b = e.target.closest('[data-act]'); … })`)
   and rows carry `data-act="kill" data-sid="…"`. New rows should use delegation; the
   `window.cortex` namespace is the compatibility bridge so the migration can be done tab-by-tab
   without rewriting every string at once.

### Tab module contract (client side)

```js
// assets/tabs/<tab>.js
/** @typedef {import('../core.js').Ctx} Ctx */
export default {
  id: 'overview',                  // matches data-tab / panel id suffix
  init(el, ctx) { /* one-time: wire listeners, register cortex.* actions, lazy fetches */ },
  refresh(el, ctx) { /* idempotent: render from ctx.data; called on activate + each SSE push */ },
};
```

- `init(el, ctx)` runs **once**, the first time the tab is activated (mirrors today's lazy
  `renderLogs._filtersWired`, `agentsLoaded`, sort-header wiring, source-vault load).
- `refresh(el, ctx)` runs on activation **and** on every SSE push **while the tab is active**.
  Must be cheap + idempotent (full re-render of innerHTML is fine, as today).
- Tabs read data **only** from `ctx.data` (the payload). Tabs that need extra fetches
  (Agents → `/dashboard/api/agents|teams|skills`, Agent-diary, source-vaults) do them in
  `init` (one-shot) or via explicit user action, caching on the module — never per SSE tick.
- Tabs never touch other tabs' DOM and never open their own EventSource.

`app.js` wiring:

```js
import { registerTab, boot } from './core.js';
import overview from './tabs/overview.js';
import sessions from './tabs/sessions.js';
/* …6 more… */
[overview, sessions, ratelimits, vault, intelligence, agents, code, logs].forEach(registerTab);
boot();
```

### Mapping current functions → modules (no logic changes)

| Today | Goes to |
| --- | --- |
| `fmt*`, `latClass`, `esc`, `escAttr`, `truncate`, `fmtBytes` | `assets/lib/fmt.js` + `assets/lib/dom.js` |
| `showToast`, `postAction`, `copyLogLine` | `core.js` |
| `drawChart` + stacked-area + health gauge math | `assets/lib/charts.js` |
| `switchTab`, tab-bar wiring, SSE, clock, `renderCurrentTab` | `core.js` |
| `renderOverview` + `renderToolTable` + sort state/header wiring | `tabs/overview.js` |
| `renderSessions`, `killSessionAction` | `tabs/sessions.js` |
| `renderRateLimits`, `resetRateLimitAction` | `tabs/ratelimits.js` |
| `renderVault`, source-vault CRUD, `runMigrationAction` | `tabs/vault.js` |
| `renderIntelligence`, `runDreamCycle`, `dismissRec` | `tabs/intelligence.js` |
| `renderAgents`, `fetchAgentsData`, `loadDiary` | `tabs/agents.js` |
| `renderCode`, `renderCodeSavings` | `tabs/code.js` |
| `renderLogs` (+ filter wiring) | `tabs/logs.js` |

---

## 4. Tab module interface (server view + registry)

A tab is a **pair**: a server fragment (`views/tabs/<tab>.ts`) and a client module
(`assets/tabs/<tab>.js`), tied together by a shared `id`. The single registry
`views/tabs.ts` is the explicit list everything composes from.

```ts
// views/tabs.ts  (server)
export interface TabDef {
  id: 'overview'|'sessions'|'ratelimits'|'vault'|'intelligence'|'agents'|'code'|'logs';
  label: string;                 // tab-bar text, e.g. 'Vault & Memory'
  render(): string;              // server-rendered HTML fragment for #tab-<id>
}

import { renderOverviewTab } from './tabs/overview.js';
/* …imports… */

export const TABS: readonly TabDef[] = [
  { id: 'overview',     label: 'Overview',       render: renderOverviewTab },
  { id: 'sessions',     label: 'Sessions',       render: renderSessionsTab },
  { id: 'ratelimits',   label: 'Rate Limits',    render: renderRateLimitsTab },
  { id: 'vault',        label: 'Vault & Memory', render: renderVaultTab },
  { id: 'intelligence', label: 'Intelligence',   render: renderIntelligenceTab },
  { id: 'agents',       label: 'Agents',         render: renderAgentsTab },
  { id: 'code',         label: 'Code',           render: renderCodeTab },
  { id: 'logs',         label: 'Logs',           render: renderLogsTab },
] as const;
```

`views/layout.ts#renderPage()`:

```ts
const tabBar = TABS.map((t, i) =>
  `<button class="tab-btn${i===0?' active':''}" data-tab="${t.id}">${esc(t.label)}</button>`
).join('');
const panels = TABS.map((t, i) =>
  `<div id="tab-${t.id}" class="tab-panel${i===0?' active':''}">${t.render()}</div>`
).join('');
```

- **Server fragment** = exactly the markup that is between `<!-- ====== TAB n ====== -->`
  comments today, lifted verbatim (then re-templated with `components.ts` helpers where it
  reduces noise). Each `render()` returns a string; **no** `<div id="tab-…" class="tab-panel">`
  wrapper inside the fragment (the layout adds it) — so fragments start at the first `.row`.
- **id is the join key**: panel id `tab-${id}`, tab button `data-tab="${id}"`, client module
  `export default { id, … }`. The default-active tab is `TABS[0]` (overview).
- Adding a tab later = add a `TabDef` + a `views/tabs/<x>.ts` + an `assets/tabs/<x>.js` +
  register in `app.js`. No other file changes. (We are **not** adding tabs now — this just
  makes the structure honest.)

Tabs are independent and parallel-implementable: each owns its fragment, its client module,
and its slice of the payload (documented in `payload.types.ts`). The only shared surfaces are
`core.js` (helpers) and the `DashboardPayload` shape.

---

## 5. UX refresh direction (visual only)

Keep it a **dark control panel**. Modernize spacing, hierarchy, and brand. Same 8 tabs, same
data, same layout grid. The current palette (`#0d1117` GitHub-dark) is fine as a base — we
formalize it into tokens and tighten the component set.

### Brand fixes (required)

- `<title>`: `cortexmd — Control Panel` (was `Obsidian MCP - Control Panel`).
- Header `<h1>`: `<span>cortexmd</span> <span class="h1-sub">Control Panel</span>` (was
  `Obsidian MCP — Control Panel`). Brand word in `--brand` accent, subtitle in `--text-dim`.
- Optional small mark glyph before the wordmark (a simple SVG/▣ neuron-ish glyph, inline, no
  asset/dep). Keep ≤16px.

### Design tokens (`assets/app.css` `:root`)

Replace the ad-hoc vars with a named token scale. Keep the existing variable names that the
client JS string-references (`var(--blue)`, `var(--green)`, `var(--red)`, `var(--yellow)`,
`var(--text-dim)`, `var(--border)`, `var(--card)`, `var(--bg)`, `var(--text)`, `var(--mono)`)
as **aliases** so no JS string needs editing, and add the new scale on top.

```css
:root {
  /* Surface / structure */
  --bg:        #0b0e14;   /* slightly deeper than today for more card contrast */
  --bg-elev:   #11151d;
  --card:      #161b22;
  --card-hover:#1c2230;
  --border:    #2a313c;   /* +contrast vs old #30363d on the new bg */
  --border-strong:#3a424f;

  /* Text */
  --text:      #d6dde6;
  --text-dim:  #8b97a6;
  --text-faint:#6b7684;

  /* Brand + semantic accents (alias old names) */
  --brand:     #7c9cff;   /* cortexmd accent (indigo-blue) */
  --blue:      #58a6ff;   /* keep: charts/links/info */
  --green:     #3fb950;
  --red:       #f85149;
  --yellow:    #d29922;
  --purple:    #bc8cff;

  /* Spacing scale (4px base) */
  --sp-1:.25rem; --sp-2:.5rem; --sp-3:.75rem; --sp-4:1rem; --sp-5:1.5rem; --sp-6:2rem;

  /* Radius */
  --r-sm:6px; --r-md:8px; --r-lg:12px; --r-pill:999px;

  /* Typography */
  --font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --mono:'Cascadia Code','Fira Code','JetBrains Mono',ui-monospace,monospace;
  --fs-xs:.7rem; --fs-sm:.78rem; --fs-md:.85rem; --fs-lg:.95rem; --fs-xl:1.15rem;
  --lh:1.5;

  /* Elevation */
  --shadow-1:0 1px 2px rgba(0,0,0,.3);
  --shadow-2:0 4px 16px rgba(0,0,0,.4);

  /* Motion */
  --t-fast:.12s; --t:.18s;
}
```

Accessibility: `--text` on `--bg` ≈ 11:1; `--text-dim` on `--card` ≈ 5.4:1 (≥4.5 AA). Accent
colors are used for icons/borders/non-essential text; any colored text on a colored chip uses
the existing high-contrast pairings (e.g. red text on `rgba(248,81,73,.15)`), which already
pass. Add `:focus-visible { outline:2px solid var(--brand); outline-offset:2px }` globally for
keyboard users (currently missing).

### Component classes (consolidate; document the canonical set)

Use these everywhere; delete one-off inline `style="…"` blocks where a class exists. (We keep
back-compat for the JS-referenced `var(--*)` but should migrate gross inline styles to classes
during the per-tab extraction.)

- **Layout**: `.shell`, `.header`, `.tab-bar`, `.tab-btn`(`.active`), `.content`,
  `.tab-panel`(`.active`), grid `.row` + `.row-1|2|3|4` (unchanged breakpoints; verify they
  collapse cleanly at 900/560px — already do).
- **Card**: `.card` (token-driven padding `var(--sp-5)`, `--r-md`, `--shadow-1`,
  hover `--card-hover`/`--border-strong`). Variants: `.card--pad-sm`, `.card--center`.
  `.card-label` (uppercase micro-label), `.card-value` (mono stat), `.card-sub`.
  `.section-title` (card/section heading) + new `.section-head` flex row (title + actions) to
  replace the repeated `style="display:flex;justify-content:space-between…"` inline blocks.
- **Table**: `.table-wrap` + `table` (rename ad-hoc `.data-table` in the Code tab to the same
  base `table` for consistency). Sortable `th[data-col]` + `.sort-arrow` unchanged.
  Zebra/hover already present; keep.
- **Badge**: `.badge` + `.badge-hot|warm|cold` (temperature), plus generic `.badge--ok`,
  `.badge--warn`, `.badge--info`, `.badge--muted` to replace inline-styled badges
  (env/persisted vault badges, silent/via diary badges).
- **Button**: `.btn`, `.btn-primary`, `.btn-danger`, add `.btn--ghost`, `.btn--sm`
  (the `font-size:.65rem;padding:.15rem .4rem` inline dismiss buttons become `.btn.btn--sm`).
- **Action chips**: `.action-badge` + `.action-link|review|consolidate|archive` (unchanged).
- **Feeds/logs/charts**: `.feed`, `.feed-item`, `.log-entry`(+levels), `.error-item`,
  `.search-item`, `.score-row`, `.cat-row`, `.stacked-bar`/`.seg`, `.hist-bar`, `.theme-card`,
  `.rec-card`, `.health-factor`, `.llm-suggestion`, `.dh-row`, `.chart-wrap` — keep as-is,
  re-pointed at tokens (spacing/radius/colors via vars).
- **Toast**: `.toast-container`, `.toast`(+`.success`/`.error`) — keep; restyle with
  `--shadow-2`, `--r-md`.
- **Form controls**: add `.input`, `.select`, `.textarea`, `.field`/`.field-label` to replace
  the long inline-styled inputs in the Vault add-vault form and the Logs/Agents `<select>`s.

### Visual hierarchy + spacing

- Increase inter-row gap to `var(--sp-4)` and card padding to `var(--sp-5)`; section heads get
  `margin-bottom:var(--sp-3)`. Sticky `.header` + `.tab-bar` (`position:sticky;top:0;z-index`)
  so navigation stays visible while scrolling the long Vault/Intelligence tabs.
- Cards get a subtle top accent option `.card--accent` (1px `--brand` top border) reserved for
  the primary stat row on Overview, to anchor the eye.
- Status dot in header: keep green pulse for "Online"; add an SSE-connection indicator that
  flips to `--yellow` ("reconnecting") when `es.onerror` fires (core sets a `body[data-sse]`
  attribute; CSS styles the dot). Pure visual, no data change.
- Responsive: the grid already collapses; additionally make `.tab-bar` horizontally scrollable
  with a fade edge on small screens (it already has `overflow-x:auto`). Tables stay in
  `.table-wrap` (scroll-x) — keep.

### Explicitly out of scope

No re-organizing which metric lives on which tab, no new charts/widgets, no renaming of tabs
beyond the brand title, no new endpoints. This is paint + structure, not product.

---

## 6. Migration plan (incremental, build stays green)

Do it in slices so `npm run build` + `npx vitest run` stay green at every commit.

1. **Scaffold + assets, no behavior change.**
   - Create `src/dashboard/` tree. Move the inline `<style>` verbatim into `assets/app.css`;
     move the inline `<script>` body verbatim into a single `assets/app.js` (still one IIFE,
     not yet split). Change `views/layout.ts#renderPage()` to emit `<link>`/`<script src>`
     instead of inline blobs. Wire `routes/page.ts` static serving (§2). Keep
     `dashboardRouter` otherwise identical (move route handlers into `controller.ts` unchanged).
   - Update `src/index.ts` import to `from './dashboard/index.js'` **or** keep `src/dashboard.ts`
     as a 1-line re-export shim: `export { dashboardRouter } from './dashboard/index.js';`
     (shim avoids touching index.ts at all). Prefer the shim for the first commit.
   - **Build copy step (the single allowed build change):** ensure `assets/**` is present in
     `dist`. Add to `package.json` `build`: `tsc && cpx? ` — but `cpx` is a dep (disallowed).
     Instead use a Node one-liner already available: `tsc && node -e "fs.cpSync('src/dashboard/assets','dist/dashboard/assets',{recursive:true})"`.
     `fs.cpSync` is Node 22 builtin — no dep. Verify `dist/dashboard/assets/app.css` exists
     after build; resolve asset dir via `fileURLToPath(new URL('../assets', import.meta.url))`.
   - Verify: page renders identically, `npm audit` still 0, tests green.

2. **Split the controller/model.** Move payload assembly to `model/payload.ts` + the
   per-concern model files; move mutable state to `model/state.ts`; move
   `computeHealthScore`/`computeTempBalance` to `model/health.ts`. Routes call model fns.
   Behavior identical; add a couple of unit tests for `computeHealthScore` (pure, easy).

3. **Split the view fragments.** Carve `DASHBOARD_HTML`'s 8 tab blocks into
   `views/tabs/*.ts` + the `TABS` registry + `layout.ts`. Pure string moves.

4. **Split the client JS** into `core.js` + `lib/*.js` + `tabs/*.js` per §3/§4, introducing the
   `init/refresh` contract and `window.cortex` action namespace. One tab at a time; after each,
   load the page and confirm that tab still updates over SSE.

5. **Apply the UX refresh** in `app.css` (tokens + components) + the brand fixes in
   `layout.ts`. Migrate inline `style="…"` to component classes opportunistically as each tab
   fragment is touched. No functional change.

### Acceptance per slice

- `cd D:/dev/cortexmd/packages/server && npm run build` → tsc clean.
- `npx vitest run` (bare env) → green.
- `npm audit` → still 0.
- Manual: `GET /dashboard` after login renders all 8 tabs; SSE updates the active tab;
  admin actions (kill session, reset rate limit, rebuild index, run dream, run benchmark,
  migrate dry-run) still work; assets load with correct MIME + 200 behind auth.

---

## 7. Invariants (do not break)

- **One** `EventSource('/dashboard/events')`, owned by `core.js`, feeding all tabs.
- SSE payload shape is unchanged; `model/payload.ts` returns the exact same JSON keys clients
  read today (enumerated in `payload.types.ts`). The `...getMetrics()` spread (source of
  `codeNav`, `codeNavSavings`, `toolCalls`, `latencyHistory`, etc.) is preserved.
- Async-cached fields (`memoryStack`, `agentDiaries`) keep their "show last value, refresh in
  background" semantics — now in `model/state.ts`.
- All endpoint paths, methods, and request/response bodies are byte-identical.
- HTML escaping uses the same detached-DOM `esc`/`escAttr` semantics client-side; server
  fragments are static (no user data) except where the existing code already escapes.
- Auth: assets + page + api + sse all stay under `/dashboard` (or `/api/source-vaults`, which
  keeps its own `dashboardAuthMiddleware`), nothing newly public.
- No new npm dependency; `npm audit` stays at 0; no bundler; client served as native ESM + CSS.
```
