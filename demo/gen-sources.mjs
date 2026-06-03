#!/usr/bin/env node
/**
 * Generates the demo SOURCE_VAULT — a read-only "engineering vault" of densely
 * interlinked markdown notes for a fictional company (Helios). Running the
 * server against this directory populates the Vault, Graph, and Intelligence
 * dashboard tabs with realistic, well-connected data.
 *
 * The graph is built from [[wikilinks]] between notes, and a link only becomes
 * an edge when its target note actually exists — so this file deliberately
 * cross-links people ↔ projects ↔ decisions ↔ concepts ↔ meetings, with a
 * shared "Concepts" layer that many notes reference (high-degree hubs). That's
 * what gives the Graph tab a full, structured look instead of a sparse cluster.
 *
 * The output (demo/sources/) is committed, so you normally don't need to run
 * this — just point SOURCE_VAULTS at demo/sources. Re-run only to regenerate.
 *
 *   node demo/gen-sources.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'sources');
rmSync(ROOT, { recursive: true, force: true });

const today = '2026-06-03';
const recent = '2026-06-01';
const mid = '2026-05-20';
const old = '2026-04-12';

/** Render a [[wikilink]] from a bare note name (basename resolution). */
const L = (name) => `[[${name}]]`;
/** Render a bullet list of links. */
const links = (names) => names.map((n) => `- ${L(n)}`).join('\n');

/** Write a note with frontmatter + body. */
function note(path, fm, body) {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  const yaml = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${v}`;
    })
    .join('\n');
  writeFileSync(full, `---\n${yaml}\n---\n\n${body.trim()}\n`);
}

// ── Concepts (the shared hub layer — referenced by many notes) ───────────────
const concepts = {
  'Hybrid Retrieval': ['Combines lexical and semantic signals.', ['BM25', 'Vector Search', 'Reciprocal Rank Fusion', 'Reranking']],
  'BM25': ['Classic lexical ranking over an inverted index.', ['Hybrid Retrieval', 'Reciprocal Rank Fusion']],
  'Vector Search': ['Nearest-neighbour search over dense embeddings.', ['Embeddings', 'Hybrid Retrieval', 'HNSW Index']],
  'Embeddings': ['Dense vector representations of text.', ['Vector Search', 'HNSW Index']],
  'HNSW Index': ['Graph-based approximate nearest-neighbour index.', ['Vector Search', 'Embeddings']],
  'Reciprocal Rank Fusion': ['Rank-level fusion of multiple result lists.', ['BM25', 'Vector Search', 'Hybrid Retrieval']],
  'Reranking': ['Re-scores top candidates with a stronger model.', ['Hybrid Retrieval']],
  'Heat Decay': ['Memories cool over time unless re-accessed.', ['Memory Temperature', 'Auto-Archival']],
  'Memory Temperature': ['Hot / warm / cold tiers derived from heat.', ['Heat Decay', 'Auto-Archival']],
  'Auto-Archival': ['Cold memories are archived by the dream pass.', ['Heat Decay', 'Memory Temperature', 'Dream Cycle']],
  'Dream Cycle': ['Nightly consolidation + link suggestion pass.', ['Auto-Archival', 'Knowledge Graph']],
  'Knowledge Graph': ['Temporal subject–predicate–object triples.', ['Dream Cycle', 'Entity Detection']],
  'Entity Detection': ['Heuristic NER feeding the knowledge graph.', ['Knowledge Graph']],
  'Model Context Protocol': ['The MCP wire protocol agents speak.', ['Shared Memory']],
  'Shared Memory': ['One brain vault shared across AI tools.', ['Model Context Protocol', 'Single-Writer Vault']],
  'Single-Writer Vault': ['The server is the only writer.', ['Shared Memory']],
  'Symbol IDs': ['Stable cross-language symbol identifiers.', ['Code Navigation']],
  'Code Navigation': ['Symbol search + call graph + change impact.', ['Symbol IDs']],
};
for (const [name, [summary, rel]] of Object.entries(concepts)) {
  note(`Concepts/${name}.md`,
    { title: name, tags: ['concept'], type: 'concept', created: old, last_accessed: today, access_count: 6 },
    `# ${name}\n\n${summary}\n\n## Related concepts\n${links(rel)}`);
}

// ── People (CRM) ─────────────────────────────────────────────────────────────
const people = {
  'Ada Lovelace': ['Staff Engineer', 'Owns retrieval. Drove hybrid search.',
    ['Helios Search', 'Hybrid Retrieval', 'Reciprocal Rank Fusion', 'Adopt Hybrid Retrieval', 'Grace Hopper', 'Alan Turing', 'Search Sync']],
  'Grace Hopper': ['Principal Engineer', 'Owns the memory lifecycle + deploy pipeline.',
    ['Memory Lifecycle', 'Heat Decay', 'Auto-Archival', 'Heat Decay Half-Life', 'Katherine Johnson', 'Alan Turing', 'Lifecycle Review']],
  'Alan Turing': ['VP Engineering', 'Sets roadmap across all projects.',
    ['Helios Search', 'Memory Lifecycle', 'Agent Mesh', 'Eng Staff', 'One Writer Brain Vault']],
  'Katherine Johnson': ['ML Engineer', 'Owns evaluation + benchmarks.',
    ['Eval Harness', 'Helios Search', 'Reranking', 'Rerank Top-50 Only', 'Ada Lovelace', 'Search Sync']],
  'Edsger Dijkstra': ['Senior Engineer', 'Code-nav + symbol indexing.',
    ['Code Atlas', 'Code Navigation', 'Symbol IDs', 'Adopt Symbol IDs', 'Barbara Liskov']],
  'Barbara Liskov': ['Senior Engineer', 'Knowledge graph + entities.',
    ['Knowledge Graph', 'Entity Detection', 'Memory Lifecycle', 'Dream Cycle', 'Grace Hopper']],
  'Margaret Hamilton': ['Engineering Manager', 'Reliability + on-call.',
    ['Memory Lifecycle', 'Agent Mesh', 'Eng Staff', 'Alan Turing']],
  'Donald Knuth': ['Research Engineer', 'Ranking quality + analysis.',
    ['Helios Search', 'Reranking', 'Reciprocal Rank Fusion', 'Katherine Johnson']],
};
for (const [name, [role, blurb, rel]] of Object.entries(people)) {
  note(`CRM/People/${name}.md`,
    { title: name, tags: ['person'], role, created: old, last_accessed: today, access_count: 9 },
    `# ${name}\n\n${role}. ${blurb}\n\n## Connections\n${links(rel)}`);
}

// ── Projects ─────────────────────────────────────────────────────────────────
const projects = {
  'Helios Search': ['active', 'Hybrid lexical + semantic retrieval over the knowledge base.',
    ['Ada Lovelace', 'Katherine Johnson', 'Donald Knuth', 'Hybrid Retrieval', 'Reciprocal Rank Fusion', 'Reranking',
     'Adopt Hybrid Retrieval', 'Rerank Top-50 Only', 'Memory Lifecycle', 'Eval Harness', 'Search Sync']],
  'Memory Lifecycle': ['active', 'Heat/decay model aging memories hot → warm → cold.',
    ['Grace Hopper', 'Barbara Liskov', 'Heat Decay', 'Memory Temperature', 'Auto-Archival', 'Dream Cycle',
     'Heat Decay Half-Life', 'Helios Search', 'Lifecycle Review']],
  'Agent Mesh': ['planning', 'Shared-memory layer so multiple AI agents share one brain.',
    ['Alan Turing', 'Margaret Hamilton', 'Model Context Protocol', 'Shared Memory', 'Single-Writer Vault',
     'One Writer Brain Vault', 'Memory Lifecycle', 'Mesh Kickoff']],
  'Eval Harness': ['active', 'Offline evaluation gating every search launch.',
    ['Katherine Johnson', 'Reranking', 'Helios Search', 'Rerank Top-50 Only']],
  'Code Atlas': ['active', 'Code navigation: symbol search, call graph, change impact.',
    ['Edsger Dijkstra', 'Code Navigation', 'Symbol IDs', 'Adopt Symbol IDs']],
};
for (const [name, [status, blurb, rel]] of Object.entries(projects)) {
  note(`Projects/${name}.md`,
    { title: name, tags: ['project', status], status, created: old, last_accessed: today, access_count: 18 },
    `# ${name}\n\n${blurb}\n\n## Owners & links\n${links(rel)}`);
}

// ── Decisions (ADRs) ─────────────────────────────────────────────────────────
const decisions = {
  'Adopt Hybrid Retrieval': ['Ada Lovelace', 'Fuse BM25 + vector search via RRF; hybrid won every eval slice.',
    ['Helios Search', 'Hybrid Retrieval', 'BM25', 'Vector Search', 'Reciprocal Rank Fusion']],
  'Rerank Top-50 Only': ['Katherine Johnson', 'Cap reranking at top-50 fused candidates to hold p95 under 400ms.',
    ['Helios Search', 'Eval Harness', 'Reranking']],
  'Heat Decay Half-Life': ['Grace Hopper', 'Memory heat halves every 14 days absent access.',
    ['Memory Lifecycle', 'Heat Decay', 'Memory Temperature', 'Auto-Archival']],
  'One Writer Brain Vault': ['Alan Turing', 'The server is the sole writer; sources are read-only.',
    ['Agent Mesh', 'Single-Writer Vault', 'Shared Memory']],
  'Adopt Symbol IDs': ['Edsger Dijkstra', 'Stable cross-language symbol IDs shared by the TS + Rust indexers.',
    ['Code Atlas', 'Symbol IDs', 'Code Navigation']],
};
for (const [name, [owner, blurb, rel]] of Object.entries(decisions)) {
  note(`Decisions/${name}.md`,
    { title: `ADR: ${name}`, tags: ['decision', 'adr'], status: 'accepted', created: mid, last_accessed: today, access_count: 11 },
    `# ADR: ${name}\n\n**Status:** Accepted · **Owner:** ${L(owner)}\n\n${blurb}\n\n## References\n${links(rel)}`);
}

// ── Meetings ─────────────────────────────────────────────────────────────────
const meetings = {
  '2026-06-01 Search Sync': ['Search Sync', ['Ada Lovelace', 'Katherine Johnson', 'Donald Knuth', 'Helios Search', 'Reciprocal Rank Fusion', 'Rerank Top-50 Only']],
  '2026-06-02 Eng Staff': ['Eng Staff', ['Alan Turing', 'Margaret Hamilton', 'Helios Search', 'Memory Lifecycle', 'Agent Mesh']],
  '2026-05-28 Lifecycle Review': ['Lifecycle Review', ['Grace Hopper', 'Barbara Liskov', 'Memory Lifecycle', 'Heat Decay', 'Heat Decay Half-Life']],
  '2026-05-30 Mesh Kickoff': ['Mesh Kickoff', ['Alan Turing', 'Margaret Hamilton', 'Agent Mesh', 'Shared Memory', 'One Writer Brain Vault']],
};
for (const [file, [title, rel]] of Object.entries(meetings)) {
  note(`Meetings/${file}.md`,
    { title, tags: ['meeting'], created: recent, last_accessed: today, access_count: 5 },
    `# ${title}\n\nAttendees & topics:\n\n${links(rel)}`);
}

// ── Maps of Content (extra hubs) ─────────────────────────────────────────────
note('Maps/Search MOC.md',
  { title: 'Search — Map of Content', tags: ['moc'], created: old, last_accessed: today, access_count: 8 },
  `# Search — Map of Content\n\n${links(['Helios Search', 'Eval Harness', 'Hybrid Retrieval', 'BM25', 'Vector Search', 'Reciprocal Rank Fusion', 'Reranking', 'Adopt Hybrid Retrieval', 'Rerank Top-50 Only', 'Ada Lovelace', 'Katherine Johnson', 'Donald Knuth'])}`);
note('Maps/Memory MOC.md',
  { title: 'Memory — Map of Content', tags: ['moc'], created: old, last_accessed: today, access_count: 8 },
  `# Memory — Map of Content\n\n${links(['Memory Lifecycle', 'Agent Mesh', 'Heat Decay', 'Memory Temperature', 'Auto-Archival', 'Dream Cycle', 'Knowledge Graph', 'Entity Detection', 'Shared Memory', 'Single-Writer Vault', 'Heat Decay Half-Life', 'One Writer Brain Vault', 'Grace Hopper', 'Barbara Liskov'])}`);

// ── A couple of cold / orphan-ish notes for realistic health metrics ─────────
note('Archive/Old BM25 Tuning.md',
  { title: 'Old BM25 Tuning Notes', tags: ['archive'], status: 'archived', created: '2025-11-02', last_accessed: '2025-12-20', access_count: 1 },
  `# Old BM25 Tuning Notes\n\nPre-hybrid baseline. Superseded by ${L('Adopt Hybrid Retrieval')}.`);
note('Inbox/Scratch.md',
  { title: 'Scratch', tags: ['inbox'], created: today, last_accessed: today, access_count: 0 },
  `# Scratch\n\nIdea: try a cross-encoder ${L('Reranking')} model? Compare to the top-50 cap.`);

console.log('Generated demo source vault at', ROOT);
