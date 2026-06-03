---
title: "ADR: Rerank Top-50 Only"
tags: ["decision", "adr"]
status: "accepted"
created: "2026-05-20"
last_accessed: "2026-06-03"
access_count: 11
---

# ADR: Rerank Top-50 Only

**Status:** Accepted · **Owner:** [[Katherine Johnson]]

Cap reranking at top-50 fused candidates to hold p95 under 400ms.

## References
- [[Helios Search]]
- [[Eval Harness]]
- [[Reranking]]
