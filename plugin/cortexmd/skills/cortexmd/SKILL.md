---
description: Use cortexmd's cheap code-navigation and memory tools instead of Read/Grep when working in an indexed repo or when knowledge worth recalling is created. Triggers on code search/navigation, "remember this", and session recall.
---

# cortexmd — code-nav & memory

cortexmd exposes MCP tools that are far cheaper than Read/Grep for TS/JS/Python/Rust/Go,
plus a persistent memory + knowledge graph. Prefer them.

## Cheap code-navigation (≈60 tokens/result) — prefer over Read/Grep

- `code_symbol_search(query, repo)` — find symbols by name/signature/docstring
- `code_file_outline(repo, path)` — file overview without reading the body
- `code_symbol_get(id)` — body of one symbol (capped ~200 lines)
- `code_symbol_callers(id)` / `code_symbol_callees(id)` — call-graph navigation
- `code_change_impact(id, depth)` — transitive callers ("if I change X, who breaks?")
- `code_call_chain(source, target)` — shortest call path
- `code_find_semantic_duplicates(repo)` / `code_find_dead_code(repo)` / `code_find_import_cycles(repo)`

Read/Grep are the fallback — only when the symbol is missing from the index or you
need literal bytes (comments, non-source content).

## Freshness — the index is live; don't fall back to Read because it "might be stale"

The code index is **kept live**, so out-of-date results are not a reason to abandon
code-nav and read whole files:

- The **PreToolUse hook** incrementally re-indexes changed files (mtime-filtered) on
  each tool call, so edits you just made are picked up automatically.
- If you still suspect the index is behind (e.g. files changed outside this session),
  **re-index it — don't read the files**:
  - run `cortexmd index <repo-path>` (or `cortexmd scan <dev-root>`), or
  - call `code_index_repo(repo)` over MCP.
  Both are **cheap, content-hash incremental** re-indexes — they only re-parse files
  whose contents actually changed, then you re-query.
- `code_check_staleness` reports which notes' `code_refs` have drifted; treat any drift
  as "re-index and re-query", not "read the source by hand".

Reaching for Read/Grep because the index *might* be stale defeats the point. Refresh it
(it's live and cheap) and stay on code-nav.

### Remote server / "indexed on another machine"

When the server is remote (e.g. containerized) and the source checkout lives on a
different machine, an empty `code_symbol_search(query, repo: <slug>)` returns a
**machine-aware hint** naming the machine that owns the index and how stale it is,
and **auto-requests a re-index** from that machine (`reindexRequested: [...]`). That
machine's `hud-line` daemon fulfills the request in the background and pushes fresh
symbols, so the fix is to **retry the query shortly** — not to fall back to Read/Grep.
To force it immediately, run `cortexmd index <repo-path>` on the owning machine.

## Memory & knowledge graph

- `memory_wakeup(agentName, preset)` — boot context (`preset: tiny|standard|full`)
- `memory_recall(query)` — hybrid recall over memories + notes
- `memory_store(content, ...)` — store a durable fact/decision/observation (auto-links + KG seed)
- `notes_upsert` / `notes_get` / `notes_search` — vault notes
- `kg_query` / `graph_neighbors` / `graph_traverse` — knowledge-graph navigation
- `memory_dream` — consolidation: decay, archive, and reconcile cold notes into projects

## Hooks (installed by this plugin)

- **UserPromptSubmit** → `cortexmd recall --hook` recalls relevant memory per prompt (the sweep).
- **SessionStart** → keeps the HUD statusline daemon alive.
- **PreToolUse:Bash** → rewrites `grep`/`cat`/`head`/`tail` on indexed repos to code-nav.
- **PostToolUse:Bash** → captures high-signal commands as memories.

These require the `cortexmd` binary on `PATH` and a running cortexmd server (see the
plugin README).
