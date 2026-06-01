/**
 * Server-side HTML component helpers returning HTML strings. Pure functions,
 * no Express. Tab fragments use these to cut markup duplication and to share
 * the canonical component classes defined in assets/app.css (REVAMP.md §2).
 *
 * The KPI/pill/delta/empty helpers below are the shared vocabulary the per-tab
 * agents reuse — prefer these over hand-rolled markup so every tab restyles
 * together and stays accessible. Dynamic values are still filled client-side
 * (the SSE tab modules write into the `id`s these helpers emit).
 */

/** Minimal HTML escape for any server-injected text. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A dashboard card wrapper. */
export function card(inner: string, opts: { className?: string } = {}): string {
  const cls = opts.className ? ` ${opts.className}` : '';
  return `<div class="card${cls}">${inner}</div>`;
}

/** A section title heading. */
export function sectionTitle(text: string, opts: { inline?: boolean } = {}): string {
  const style = opts.inline ? ' style="margin-bottom:0"' : '';
  return `<div class="section-title"${style}>${text}</div>`;
}

/** A flex header row (title + actions) replacing repeated inline flex blocks. */
export function sectionHead(title: string, actions: string): string {
  return `<div class="section-head">${sectionTitle(title, { inline: true })}<div class="section-head-actions">${actions}</div></div>`;
}

/** A `.row` grid wrapper. `cols` maps to `.row-N`. */
export function row(cols: 1 | 2 | 3 | 4, inner: string): string {
  return `<div class="row row-${cols}">${inner}</div>`;
}

/** A `.table-wrap` scroll container. */
export function tableWrap(inner: string): string {
  return `<div class="table-wrap">${inner}</div>`;
}

// ── Insight-layer components (REVAMP.md §2b/§2c/§2i) ─────────────────────────

export interface KpiOpts {
  /** Uppercase label (sans). */
  label: string;
  /** Element id the SSE tab module writes the headline value into. */
  valueId: string;
  /** Initial value text (skeleton-friendly default). */
  value?: string;
  /** Sub-line element id (mono meta). */
  subId?: string;
  /** Initial sub-line text. */
  sub?: string;
  /** Optional status-pill id (filled client-side). */
  pillId?: string;
  /** Optional delta-chip id (filled client-side). */
  deltaId?: string;
  /** Optional spark <svg> id → drives drawChart. */
  sparkId?: string;
  /** Render the headline number in mono (raw IDs only). */
  mono?: boolean;
  /** Extra classes on the tile. */
  className?: string;
  /** If set, make the tile a deep-link button switching to this tab id. */
  linkTab?: string;
  /** Slot rendered between value and spark (e.g. a stacked bar). */
  body?: string;
}

/**
 * The signature KPI scorecard: spectral top hairline, big sans value, optional
 * status pill + delta chip + sparkline foot. Renders stable `id`s the client
 * fills over SSE. When `linkTab` is set it is a real focusable <button> that
 * switches tabs (handled by core's `window.cortex.switchTab`).
 */
export function kpi(o: KpiOpts): string {
  const tag = o.linkTab ? 'button' : 'div';
  const linkCls = o.linkTab ? ' is-link' : '';
  const extra = o.className ? ` ${o.className}` : '';
  const attrs = o.linkTab
    ? ` type="button" onclick="window.cortex.switchTab('${esc(o.linkTab)}')" aria-label="${esc(o.label)} — open ${esc(o.linkTab)} tab"`
    : '';
  const valueCls = o.mono ? 'card-value card-value--mono' : 'card-value';
  const pill = o.pillId ? `<span id="${esc(o.pillId)}"></span>` : '';
  const delta = o.deltaId ? `<span id="${esc(o.deltaId)}"></span>` : '';
  const foot = (pill || delta) ? `<div class="kpi-foot">${pill}${delta}</div>` : '';
  const sub = o.subId
    ? `<div class="card-sub" id="${esc(o.subId)}">${o.sub ? esc(o.sub) : ''}</div>`
    : (o.sub ? `<div class="card-sub">${esc(o.sub)}</div>` : '');
  const spark = o.sparkId
    ? `<svg class="kpi-spark" id="${esc(o.sparkId)}" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"></svg>`
    : '';
  return `<${tag} class="card card--kpi${linkCls}${extra}"${attrs}` +
    ` style="text-align:left;display:block;width:100%">` +
    `<div class="card-label">${esc(o.label)}</div>` +
    `<div class="${valueCls}" id="${esc(o.valueId)}">${o.value != null ? esc(o.value) : '<span class="skel skel--kpi" aria-hidden="true"></span>'}</div>` +
    (o.body || '') + foot + sub + spark +
    `</${tag}>`;
}

export type PillState = 'ok' | 'warn' | 'bad' | 'muted';

/** A status pill (good/warn/bad/muted). State is text-encoded, never color-only. */
export function statusPill(label: string, state: PillState = 'muted', opts: { id?: string; dot?: boolean } = {}): string {
  const id = opts.id ? ` id="${esc(opts.id)}"` : '';
  const dot = opts.dot === false ? '' : '<span class="dot" aria-hidden="true"></span>';
  return `<span class="pill pill--${state}"${id}>${dot}${esc(label)}</span>`;
}

/**
 * A delta chip carrying BOTH a glyph (↑/↓/→) and the % so it is never
 * color-only. `dir` drives the up/down/flat class; `invert` flips good/bad for
 * lower-is-better KPIs (error rate, latency).
 */
export function deltaChip(dir: 'up' | 'down' | 'flat', text: string, opts: { invert?: boolean; id?: string } = {}): string {
  const glyph = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
  const inv = opts.invert ? ' invert' : '';
  const id = opts.id ? ` id="${esc(opts.id)}"` : '';
  return `<span class="kpi-delta ${dir}${inv}"${id}><span aria-hidden="true">${glyph}</span>${esc(text)}</span>`;
}

/** A label + spark row (small inline sparkline strip). */
export function sparkRow(label: string, svgId: string, opts: { className?: string } = {}): string {
  const cls = opts.className ? ` ${opts.className}` : '';
  return `<div class="spark-row${cls}">` +
    `<div class="card-label">${esc(label)}</div>` +
    `<div class="chart-wrap chart-wrap--sm"><svg id="${esc(svgId)}" viewBox="0 0 600 140" preserveAspectRatio="none" aria-hidden="true"></svg></div>` +
    `</div>`;
}

/** An empty-state block (icon + title + optional message). Never a bare dash. */
export function emptyState(title: string, message = ''): string {
  const icon =
    '<svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
    '<path d="M9 12h6"/></svg>';
  const msg = message ? `<div class="empty-msg" style="padding:0">${esc(message)}</div>` : '';
  return `<div class="empty">${icon}<div class="empty-title">${esc(title)}</div>${msg}</div>`;
}

/** An inline error-state block. */
export function stateError(message: string): string {
  const icon =
    '<svg class="state-error-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 8v4m0 4h.01"/></svg>';
  return `<div class="state-error" role="alert">${icon}<div>${esc(message)}</div></div>`;
}
