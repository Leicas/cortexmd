/**
 * Graph tab — an Obsidian-style force-directed view of the whole vault rendered
 * on <canvas>. Server fragment only (no panel wrapper); the client module
 * assets/tabs/graph.js fetches /dashboard/api/graph once, runs the force sim
 * from assets/lib/graph-sim.js, and loads a clicked note from
 * /dashboard/api/note. See ARCHITECTURE.md §4.
 */
import { card, sectionHead, emptyState } from '../components.js';

export function renderGraphTab(): string {
  const controls =
    `<div class="graph-controls">` +
      `<input id="graphSearch" type="search" class="input" placeholder="Find a note…" aria-label="Find a note in the graph" />` +
      `<select id="graphLimit" class="select" aria-label="Maximum nodes to render">` +
        `<option value="400">400 nodes</option>` +
        `<option value="800" selected>800 nodes</option>` +
        `<option value="1500">1500 nodes</option>` +
        `<option value="3000">3000 nodes</option>` +
        `<option value="0">All nodes</option>` +
      `</select>` +
      `<button id="graphFit" type="button" class="btn btn--sm">Fit</button>` +
      `<button id="graphReheat" type="button" class="btn btn--sm">Reheat</button>` +
    `</div>`;

  const stage =
    `<div class="graph-stage">` +
      `<canvas id="graphCanvas" class="graph-canvas" role="img" aria-label="Vault link graph"></canvas>` +
      `<div id="graphLoading" class="graph-loading">Loading graph…</div>` +
      `<div id="graphStat" class="graph-stat"></div>` +
    `</div>`;

  const canvasCard = card(
    sectionHead('Vault graph', controls) + stage,
    { className: 'card--graph' },
  );

  const aside = card(
    `<div id="graphNotePanel" class="graph-note">` +
      emptyState(
        'No note selected',
        'Click a node to read its content. Scroll to zoom, drag to pan, drag a node to reposition.',
      ) +
    `</div>`,
    { className: 'card--graph-aside' },
  );

  return `<div class="graph-layout">${canvasCard}${aside}</div>`;
}
