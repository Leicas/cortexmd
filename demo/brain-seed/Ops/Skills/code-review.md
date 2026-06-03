---
type: skill
name: code-review
display_name: Code Review
description: Review a diff for correctness, reuse, and simplification before it lands.
trigger: when a change is ready for review or a PR is opened
tags: [code, quality]
---

# Code Review

Walk the diff symbol-by-symbol with `code_full_context`, check `code_change_impact`
for blast radius, and confirm the change matches the decision recorded in the
relevant ADR under Decisions/.
