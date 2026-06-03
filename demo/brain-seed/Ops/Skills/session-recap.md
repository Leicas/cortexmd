---
type: skill
name: session-recap
display_name: Session Recap
description: Write an end-of-session diary entry so the next agent picks up with full context.
trigger: at the end of a working session, or on a Stop hook
tags: [memory, process]
---

# Session Recap

Summarize what changed, what's still open, and any decisions made. Write it with
`diary_write` and link the projects and notes touched so the recap joins the
knowledge graph.
