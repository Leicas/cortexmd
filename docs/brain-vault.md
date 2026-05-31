# The brain-vault model

The single most important design decision in cortexmd is the separation of
**what it reads** from **what it writes**. Everything else — dual-mode
deployment, the transport seam, the absence of sync logic — follows from it.

## Sole writer, read-only sources

- **`BRAIN_VAULT`** — a vault that cortexmd **owns**. It is the **only**
  directory the server ever writes to: memories, journal entries, agent
  diaries, tasks, knowledge-graph notes, and `code-repos.json` all live here.
  It defaults to a dedicated per-user data directory, explicitly **not** your
  Obsidian vault:

  | OS | Default |
  |----|---------|
  | Linux/macOS | `$XDG_DATA_HOME/cortexmd/brain` (else `~/.local/share/cortexmd/brain`) |
  | Windows | `%LOCALAPPDATA%\cortexmd\brain` |

  It is created on first boot.

- **`SOURCE_VAULTS[]`** — zero or more of *your* vaults, attached
  **read-only**. They are indexed (lexical + semantic + code-nav) but never
  modified. Opt-in, and each can carry a default-deny index allowlist so private
  subtrees stay out.

```
  read (one-way)                          write (only here)
  ┌────────────────────┐                 ┌──────────────────┐
  │   SOURCE_VAULTS[]   │   index         │    BRAIN_VAULT    │
  │  (your vaults, RO)  │ ──────────────▶ │  (owned by server)│
  └────────────────────┘    via IVault   └──────────────────┘
           ▲                                       ▲
           │                                       │
           └──────────── cortexmd server ──────────┘
                          (sole writer)
```

## Why this dissolves the sync hazard

The private predecessor used `VAULT_RW` + `VAULT_RO_*` and relied on
bidirectional file sync (Resilio / Syncthing) into the **same** vault the user
edited. That creates clobber/merge races between three writers: the human, the
sync agent, and the server. This was observed live — a one-time filesystem
reorganization on one peer, combined with the server's own heat/reindex writes,
produced duplicated notes the sync couldn't reconcile.

By making the server the **single writer** of a vault it **owns**, and treating
every user vault as a **read-only source**, all data flow is one-directional:

- there is no shared mutable file, so there is no merge logic and no clobber;
- the user edits their vault, cortexmd re-reads it;
- cortexmd writes only into the brain.

The sync problem isn't solved — it's **designed out**. This is also why
read-only sources need no merge logic at the transport layer; see
[`transports.md`](./transports.md).

## How writes are enforced

Write routing is an invariant, not a convention. Every write tool
(`notes_upsert`, `notes_archive`, `journal_append`, `memory_store`, `tasks_*`,
`kg_add`, `agent_diary_*`, and the `code-repos.json` mirror) resolves its target
path through a containment check that resolves **only** into `BRAIN_VAULT`. A
write aimed at a source-vault path is rejected. The check is being hardened to
use realpath resolution (not string-prefix matching) so a symlink inside a
source vault cannot escape into a write — see the write-routing tests.

The practical consequence: if a write fails with a "not in brain vault" style
error, that is the safety property working as intended.

## The allowlist

Source vaults are read-only, but "read-only" is not the same as "everything is
fair game to index." Each source vault may declare a **default-deny** index
allowlist as part of its `SOURCE_VAULTS` entry:

```
SOURCE_VAULTS="work=/data/work-kb:Projects/**|Notes/**"
```

The part after the `:` is a `|`-separated list of include globs (relative to the
vault root). Behaviour:

- **No globs** → the whole vault is indexable (opt-out / legacy behaviour).
- **One or more globs** → **only** matching vault-relative paths are walked,
  indexed, or embedded. Everything else is invisible to search.
- The segments `.obsidian`, `.sync`, and `.trash` are **hard-blocked**
  regardless of any glob — they can never be indexed.

Recommendation: for any source vault that contains private material, use
default-deny with an explicit include list. The allowlist is a privacy control,
and the brain vault is itself always fully indexable (the gate applies to source
vaults only).

## What lives in the brain

```
BRAIN_VAULT/
├── memories/         heat-scored memories with TTL decay + consolidation
├── journal/          journal entries
├── agent-diaries/    per-agent diaries
├── tasks/            task notes
├── kg/               knowledge-graph notes
└── Ops/
    └── code-repos.json   registry of indexed repos
```

Auto-stored memories embed `[[wiki-links]]` to detected entities, so they join
the graph rather than orphaning.

## Reading, editing, and syncing the brain yourself (advanced)

"Sole writer" describes how the **server** routes writes — it never writes
outside `BRAIN_VAULT`. It does **not** mean the brain is off-limits to you. The
brain is just a directory of plain Markdown + JSON that you own:

- **Reading is always safe.** Open `BRAIN_VAULT` in Obsidian (or any editor),
  grep it, back it up, put it under version control. The server doesn't lock
  files, and nothing here is an opaque database — it's your memory, in the open.
- **Editing directly works too.** Hand-edit a memory, fix a journal entry, prune
  a diary — the server has no objection. Your changes are picked up on the next
  index rebuild (`INDEX_REBUILD_INTERVAL_MS`, default 60s) like any other change.
  The only thing to avoid is editing the *exact* note a tool is writing at the
  same instant; resolution is last-write-wins, so a simultaneous collision could
  drop one side's change. In practice, edit when the agent is idle.

### Syncing the brain across devices

The brain-vault model removed the clobber hazard by having **one** writer. You
can deliberately opt back into multi-device access as an advanced setup **as long
as you preserve that one rule**:

> Exactly one cortexmd instance writes a given brain. Sync is for **fanning the
> brain out** to your other devices/editors (read + occasional edit), not for
> running a second writer against the same data.

A safe, common arrangement:

1. Run the cortexmd server on one host — that host's `BRAIN_VAULT` is the
   authority and the single writer.
2. Point a sync tool (Syncthing, Resilio, `git`, iCloud/Dropbox, …) at that
   directory and replicate it to your laptop/phone, where you open it in
   Obsidian to read and make the occasional edit.
3. Do **not** start a second server writing the same (synced) brain — that
   reintroduces the exact three-writer race this model was built to avoid.

If you do edit on a synced peer while the server is actively writing on the
host, you reopen a (smaller) two-writer window: a sync conflict can produce a
`*.sync-conflict` / `(2)` duplicate that the next index rebuild will simply
index as an extra note. For personal use that's usually an acceptable trade —
just know it's the cost of editing a live, replicated brain, and prefer editing
while the agent is idle. If you want zero risk, keep edits on the writer host.

Tip: this is independent of where the brain lives — you can set `BRAIN_VAULT` to
a folder inside an Obsidian vault you sync, as long as that folder is **not**
also attached as a `SOURCE_VAULTS` entry (keep the writable brain and read-only
sources disjoint).
