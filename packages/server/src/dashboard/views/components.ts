/**
 * Server-side HTML component helpers returning HTML strings. Pure functions,
 * no Express. Tab fragments use these to cut markup duplication. Optional —
 * fragments may also emit raw markup. Kept minimal for the scaffold; the
 * per-tab agents may extend this set (sectionHead, badge variants, etc.).
 */

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
