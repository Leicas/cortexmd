# cortexmd architecture

> Pre-alpha. This documents the target design, not necessarily everything wired up today.

## 1. The brain-vault data-flow model

cortexmd separates **what it reads** from **what it writes**, and that separation is the central design decision.

- **BRAIN_VAULT** — a vault that cortexmd *owns*. It is the **sole write target**: memories, journal entries, agent diaries, tasks, knowledge-graph notes, and `code-repos.json` all live here. It defaults to a dedicated data directory (e.g. `~/.local/share/cortexmd/brain`), explicitly **not** the user's Obsidian vault.
- **SOURCE_VAULTS[]** — zero or more of the user's own vaults, attached **read-only**. They are indexed (lexical + semantic + code-nav) but never modified. Opt-in, with a default-deny index allowlist so private subtrees can be excluded.

```
  read (one-way)                         write (only here)
  ┌────────────────────┐                ┌──────────────────┐
  │   SOURCE_VAULTS[]   │   index        │    BRAIN_VAULT    │
  │  (your vaults, RO)  │ ─────────────▶ │  (owned by server)│
  └────────────────────┘    via IVault  └──────────────────┘
           ▲                                      ▲
           │                                      │
           └──────────── cortexmd MCP server ─────┘
                          (sole writer)
```

### Why this dissolves the sync hazard

The private predecessor used `VAULT_RW` + `VAULT_RO_*` and relied on bidirectional file sync (Resilio/Syncthing) into the same vault the user edited. That creates clobber/merge races between the human, the sync agent, and the server. *(This was observed live: a one-time filesystem reorganization on one peer, combined with the server's own heat/reindex writes, produced duplicated notes that the sync couldn't reconcile.)*

By making the server the **single writer** of a vault it **owns**, and treating every user vault as a **read-only source**, all data flow is one-directional. There is no shared mutable file, so there is no merge logic and no clobber: the user edits their vault, cortexmd re-reads it; cortexmd writes only into the brain. The sync problem doesn't need solving — it's designed out.

## 2. Dual-mode deployment

Two co-equal modes share the same core; only transport and auth differ.

| | local-stdio (default) | self-hosted HTTP (advanced) |
|---|---|---|
| Transport | MCP over stdio | Express HTTP (`/mcp`) |
| Vault read | local filesystem, direct | `IVault` (git pull / WebDAV / S3) on an interval |
| Auth | none (local trust) | API key or OAuth2; Authelia/Traefik forward-auth optional |
| Sync / Docker | none | optional |
| Audience | single user on one machine | multi-client / remote |

The server selects mode at startup (e.g. `--stdio` vs binding an HTTP port). All search, memory, and code-nav logic is mode-agnostic.

## 3. The IVault transport seam

Vault access is hidden behind an `IVault` interface so the source of bytes is pluggable:

```ts
interface IVault {
  list(): Promise<string[]>;            // relative paths (allowlist-filtered)
  read(path: string): Promise<Buffer>;  // read-only for source vaults
  // write(...) exists ONLY for the brain vault implementation
  refresh(): Promise<void>;             // re-sync underlying source (no-op for Local)
}
```

Implementations:

- **Local** — direct filesystem reads. `refresh()` is a no-op (the OS already has the latest bytes). Used by local-stdio mode and for the brain vault.
- **Git** — the OSS default for HTTP mode: `git pull` a vault repo on an interval, then read the working tree. Because sources are read-only, a periodic re-pull is sufficient — there is never a push, never a merge of local edits.
- **WebDAV / S3** — future remote read backends behind the same interface.

Only the brain-vault implementation exposes writes; source-vault implementations are read-only by type, enforcing the one-way model at the seam.

## 4. Core subsystems (mode-agnostic)

- **Hybrid search** — MiniSearch (lexical, fuzzy + field boosting) fused with HNSW semantic results via Reciprocal Rank Fusion; collection weights further boost scores.
- **Memory lifecycle** — heat scoring (recency + access + links), per-category TTL decay, auto-archival, contradiction detection, consolidation. Auto-stored memories embed `[[wiki-links]]` to detected entities so they join the graph instead of orphaning.
- **Code navigation** — symbol DB fed by the Rust indexer over the `contract/` wire format; serves symbol search, outlines, call graph, change-impact, duplicate/dead-code detection. ~60 tokens/result vs whole-file reads.
- **Collections** — path-pattern classification with per-collection search weighting; shipped as customizable examples, not baked-in personal taxonomy.

## 5. Boundaries to preserve

- No hardcoded hosts, domains, or vault paths in defaults.
- Neutral MCP tool namespace (no org-specific prefix).
- Reranker hardware and models fully optional, no default endpoint.
- Authelia/Traefik documented as optional; API key or OAuth work standalone.
- Write-routing: every write resolves into `BRAIN_VAULT`, and the containment check must resist symlink escape (realpath, not string-prefix).
- Symbol-ID algorithm identical across Rust and TS, enforced by `contract/` golden fixtures.
