#!/usr/bin/env node
/**
 * Generates the demo SOURCE_VAULT — a read-only "engineering vault" of
 * interlinked markdown notes for a fictional company (Helios). Running the
 * server against this directory populates the Vault, Graph, and Intelligence
 * dashboard tabs with realistic, well-connected data.
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

const today = '2026-06-03';
const recent = '2026-06-01';
const old = '2026-04-12';

// ── People (CRM) ──────────────────────────────────────────────────────────
note('CRM/People/Ada Lovelace.md',
  { title: 'Ada Lovelace', tags: ['person', 'engineering'], role: 'Staff Engineer', created: old, last_accessed: today, access_count: 14 },
  `# Ada Lovelace

Staff engineer, owns the retrieval stack. Drove the move to hybrid search on
[[Projects/Helios Search.md]]. Pairs often with [[CRM/People/Grace Hopper.md]].

- Focus: ranking, embeddings, evaluation
- Reports to [[CRM/People/Alan Turing.md]]
- Current: [[Projects/Helios Search.md]], [[Meetings/2026-06-01 Search Sync.md]]`);

note('CRM/People/Grace Hopper.md',
  { title: 'Grace Hopper', tags: ['person', 'platform'], role: 'Principal Engineer', created: old, last_accessed: today, access_count: 11 },
  `# Grace Hopper

Principal engineer on platform + infra. Owns the [[Projects/Memory Lifecycle.md]]
decay/heat model and the deploy pipeline. Mentors [[CRM/People/Katherine Johnson.md]].

- Focus: storage, lifecycle, reliability
- Reports to [[CRM/People/Alan Turing.md]]`);

note('CRM/People/Alan Turing.md',
  { title: 'Alan Turing', tags: ['person', 'leadership'], role: 'VP Engineering', created: old, last_accessed: recent, access_count: 7 },
  `# Alan Turing

VP Engineering. Sets roadmap across [[Projects/Helios Search.md]],
[[Projects/Memory Lifecycle.md]], and [[Projects/Agent Mesh.md]].
Runs the weekly [[Meetings/2026-06-02 Eng Staff.md]].`);

note('CRM/People/Katherine Johnson.md',
  { title: 'Katherine Johnson', tags: ['person', 'data'], role: 'ML Engineer', created: old, last_accessed: today, access_count: 9 },
  `# Katherine Johnson

ML engineer focused on evaluation + benchmarks. Built the offline eval harness
used to gate [[Projects/Helios Search.md]] launches. Works with
[[CRM/People/Ada Lovelace.md]] on ranking quality.`);

// ── Projects ────────────────────────────────────────────────────────────────
note('Projects/Helios Search.md',
  { title: 'Helios Search', tags: ['project', 'search', 'active'], status: 'active', created: old, last_accessed: today, access_count: 23 },
  `# Helios Search

Hybrid lexical + semantic retrieval over the company knowledge base.

## Owners
- [[CRM/People/Ada Lovelace.md]] (lead)
- [[CRM/People/Katherine Johnson.md]] (eval)

## Key decisions
- See [[Decisions/Adopt Hybrid Retrieval.md]]
- See [[Decisions/Rerank Top-50 Only.md]]

## Open work
- Tune RRF weights — tracked in [[Meetings/2026-06-01 Search Sync.md]]
- Backfill embeddings for archived notes

Depends on [[Projects/Memory Lifecycle.md]] for heat-aware ranking.`);

note('Projects/Memory Lifecycle.md',
  { title: 'Memory Lifecycle', tags: ['project', 'memory', 'active'], status: 'active', created: old, last_accessed: today, access_count: 18 },
  `# Memory Lifecycle

Heat/decay model that ages memories from hot → warm → cold and auto-archives
the cold tail. Feeds ranking in [[Projects/Helios Search.md]].

## Owner
- [[CRM/People/Grace Hopper.md]]

## Decisions
- [[Decisions/Heat Decay Half-Life.md]]

The nightly "dream" pass consolidates clusters and proposes links.`);

note('Projects/Agent Mesh.md',
  { title: 'Agent Mesh', tags: ['project', 'agents', 'planning'], status: 'planning', created: recent, last_accessed: recent, access_count: 5 },
  `# Agent Mesh

Shared-memory layer so multiple AI agents (Claude Code, Cursor, Codex) read and
write the same brain. Built on the MCP server. See [[Decisions/One Writer Brain Vault.md]].

## Owner
- [[CRM/People/Alan Turing.md]] (sponsor)

Blocked on [[Projects/Memory Lifecycle.md]] stabilizing the write path.`);

// ── Decisions (ADR-style) ────────────────────────────────────────────────────
note('Decisions/Adopt Hybrid Retrieval.md',
  { title: 'ADR: Adopt Hybrid Retrieval', tags: ['decision', 'search', 'adr'], status: 'accepted', created: old, last_accessed: today, access_count: 16 },
  `# ADR: Adopt Hybrid Retrieval

**Status:** Accepted · **Owner:** [[CRM/People/Ada Lovelace.md]]

Combine BM25 (MiniSearch) with vector similarity, fused via Reciprocal Rank
Fusion. Pure semantic missed exact-symbol queries; pure lexical missed
paraphrases. Hybrid won every slice of the eval set.

Applies to [[Projects/Helios Search.md]]. Superseded the BM25-only baseline.`);

note('Decisions/Rerank Top-50 Only.md',
  { title: 'ADR: Rerank Top-50 Only', tags: ['decision', 'search', 'adr', 'cost'], status: 'accepted', created: recent, last_accessed: recent, access_count: 8 },
  `# ADR: Rerank Top-50 Only

**Status:** Accepted · **Owner:** [[CRM/People/Katherine Johnson.md]]

Cap LLM reranking at the top 50 fused candidates. Beyond 50, recall gains were
inside the noise floor but latency and token cost grew linearly. Keeps
[[Projects/Helios Search.md]] p95 under 400ms.`);

note('Decisions/Heat Decay Half-Life.md',
  { title: 'ADR: Heat Decay Half-Life = 14 days', tags: ['decision', 'memory', 'adr'], status: 'accepted', created: recent, last_accessed: today, access_count: 10 },
  `# ADR: Heat Decay Half-Life = 14 days

**Status:** Accepted · **Owner:** [[CRM/People/Grace Hopper.md]]

Memory heat halves every 14 days absent access. Shorter half-lives archived
useful context too aggressively; longer ones kept stale notes "hot". Drives
[[Projects/Memory Lifecycle.md]] and the nightly dream archival pass.`);

note('Decisions/One Writer Brain Vault.md',
  { title: 'ADR: Single-Writer Brain Vault', tags: ['decision', 'architecture', 'adr'], status: 'accepted', created: recent, last_accessed: recent, access_count: 12 },
  `# ADR: Single-Writer Brain Vault

**Status:** Accepted · **Owner:** [[CRM/People/Alan Turing.md]]

The MCP server is the *sole writer*. Source vaults are mounted read-only and
only ever indexed. This removes bidirectional-sync clobber hazards and is the
foundation for [[Projects/Agent Mesh.md]] sharing one memory across tools.`);

// ── Meetings ──────────────────────────────────────────────────────────────
note('Meetings/2026-06-01 Search Sync.md',
  { title: 'Search Sync — 2026-06-01', tags: ['meeting', 'search'], created: recent, last_accessed: today, access_count: 6 },
  `# Search Sync — 2026-06-01

Attendees: [[CRM/People/Ada Lovelace.md]], [[CRM/People/Katherine Johnson.md]]

- RRF weight sweep: 0.6 lexical / 0.4 semantic wins on the eval set.
- Action: ship behind a flag on [[Projects/Helios Search.md]].
- Reaffirmed [[Decisions/Rerank Top-50 Only.md]] after the latency regression.`);

note('Meetings/2026-06-02 Eng Staff.md',
  { title: 'Eng Staff — 2026-06-02', tags: ['meeting', 'leadership'], created: recent, last_accessed: today, access_count: 5 },
  `# Eng Staff — 2026-06-02

Run by [[CRM/People/Alan Turing.md]].

- [[Projects/Helios Search.md]] on track for the flagged rollout.
- [[Projects/Agent Mesh.md]] kickoff pending [[Projects/Memory Lifecycle.md]] write-path freeze.
- [[CRM/People/Grace Hopper.md]] to land [[Decisions/Heat Decay Half-Life.md]] this week.`);

// ── A couple of cold / orphan-ish notes for realistic health metrics ─────────
note('Archive/Old BM25 Tuning.md',
  { title: 'Old BM25 Tuning Notes', tags: ['archive', 'search'], status: 'archived', created: '2025-11-02', last_accessed: '2025-12-20', access_count: 1 },
  `# Old BM25 Tuning Notes

Pre-hybrid baseline parameters. Kept for history; superseded by
[[Decisions/Adopt Hybrid Retrieval.md]].`);

note('Inbox/Scratch.md',
  { title: 'Scratch', tags: ['inbox'], created: today, last_accessed: today, access_count: 0 },
  `# Scratch

Unsorted: try cross-encoder reranker? compare to current top-50 cap.`);

console.log('Generated demo source vault at', ROOT);
