# cortexmd demo

A one-command, self-contained demo of the **server (shared-memory) deployment**:
the cortexmd MCP server running over HTTP with a live dashboard, seeded with
realistic data. This is the preferred way to run cortexmd when you want one
brain shared across multiple AI tools (Claude Code, Cursor, Codex) — every tool
connects to the same server, so memory written by one is instantly visible to
the others and on the dashboard.

```sh
./demo/run.sh
```

Then open **http://localhost:7777/dashboard** (password: `demo`).

That's it. The script builds the server if needed, starts it with fixed demo
credentials, and seeds it with data by driving the MCP tools exactly like a real
agent would.

## What's in the box

| File | Purpose |
|------|---------|
| `run.sh` | Build (if needed) → start the server → seed it. One command. |
| `seed.mjs` | Drives the server's MCP tools over HTTP (plain `fetch`, zero deps): stores memories, adds knowledge-graph triples, writes journal/diary entries, creates tasks, registers + code-indexes this repo, then runs searches and a dream cycle. |
| `sources/` | A read-only **source vault** — interlinked markdown notes (people, projects, decisions, meetings) for a fictional company. Indexed for search, code-nav, and the graph. Committed, so the demo works out of the box. |
| `brain-seed/` | Agent / team / skill definitions copied into the brain vault at startup so the **Agents** tab is populated. |
| `gen-sources.mjs` | Regenerates `sources/` (you normally don't need this). |
| `screenshot.mjs` | Captures every dashboard tab to `docs/screenshots/` with Playwright. |

All runtime state (brain vault, SQLite indexes) lives under `demo/.runtime/`,
which is gitignored. Delete it for a clean slate.

## Connecting an AI tool to the running server

The whole point of server mode is **shared memory across tools**. Point any MCP
client at the running server as a Streamable-HTTP MCP endpoint:

- **URL:** `http://localhost:7777/mcp`
- **Auth:** `Authorization: Bearer demo-key`

Two agents pointed at the same URL share one brain — what one stores with
`memory_store`, the other recalls with `memory_recall`, and both show up as
distinct sessions on the dashboard's **Sessions** tab.

## Knobs

Everything is overridable via env vars (defaults in parentheses):

| Var | Default | |
|-----|---------|--|
| `API_PORT` | `7777` | dashboard + MCP port |
| `DASHBOARD_PASSWORD` | `demo` | dashboard login |
| `API_KEY` | `demo-key` | MCP Bearer token |
| `ENABLE_EMBEDDINGS` | `false` | lexical-only by default → instant boot, no model download. Set `true` to also exercise semantic search. |

```sh
ENABLE_EMBEDDINGS=true API_PORT=8080 ./demo/run.sh   # semantic search on, different port
./demo/run.sh --no-seed                              # start empty, seed yourself
```

## Refreshing the screenshots

With the server running and seeded:

```sh
node demo/screenshot.mjs        # writes docs/screenshots/*.png
```

> The demo credentials (`demo` / `demo-key`) are intentionally trivial. They are
> for a throwaway local demo only — never use them for anything reachable.
