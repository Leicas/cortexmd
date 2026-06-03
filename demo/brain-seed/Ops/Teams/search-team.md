---
type: team
name: search-team
display_name: Search Team
coordination: sequential
members:
  - agent: claude-code
    role: implementer
  - agent: codex
    role: eval & tests
  - agent: cursor
    role: reviewer
synthesizer: claude-code
shared_context: [Projects/Helios Search.md, Decisions/Adopt Hybrid Retrieval.md]
tags: [search, code]
skills: [code-review]
---

# Search Team

Ships changes to [[Projects/Helios Search.md]]. Claude Code implements, Codex
gates on the eval harness, Cursor reviews. All three read and write one shared
brain vault, so nobody re-derives context the others already captured.
