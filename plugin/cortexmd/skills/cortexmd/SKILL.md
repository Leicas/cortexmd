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
