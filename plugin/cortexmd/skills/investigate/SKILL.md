---
name: investigate
description: Investigate a bounded cross-file code question or scoped project knowledge using CortexMD's configured smaller-model worker. Use for substantial fact gathering, not simple symbol lookups, edits, or final review decisions.
---

# Bounded CortexMD investigation

Use `worker_run` when an explicitly configured worker is available and the task benefits from several related reads. Use ordinary code navigation for a simple lookup. Do not enable a provider or transmit a local checkout as an incidental repair.

1. State one concrete question, identify the registered repo, and narrow repository-relative `paths`. For knowledge use `mode: knowledge-investigator` and explicit vault-relative `note_paths`; never silently search the whole vault.
2. Invoke `worker_run` with `task`, `mode`, the scope, and optional lower `budget` limits. Code mode takes `repo` and optional `paths`; knowledge mode takes `note_paths` only. The server selects the provider/model and enforces limits. The worker only reads its restricted CortexMD tools; it cannot edit, index, store memories, or delegate again.
3. Read `status`, `coverage`, and evidence before relying on the answer. Partial, stale, unavailable, or truncated evidence is not a complete investigation. Report missing evidence plainly. Source references establish traceability, not the correctness of a claim.
4. Retrieve exact cited source and check local changes before editing or issuing a review verdict. The server's indexed snapshot is not proof of current local checkout state.
5. If worker execution is unavailable, use ordinary CortexMD navigation or targeted local reads. Do not repeatedly retry a provider/configuration failure or silently increase budgets.

CLI equivalent (uses existing server credentials; does not upload files):

```sh
cortexmd ask --repo example --question "How do errors propagate?" --path src --max-tool-calls 8
cortexmd ask --mode knowledge-investigator --note-path Projects/example --question "Why was this design selected?"
```

Keep architectural decisions, modifications, and final verification with the coordinating agent. Do not automatically save generated interpretations as memories.
