---
title: "ADR: Rerank Top-50 Only"
tags: ["decision", "search", "adr", "cost"]
status: "accepted"
created: "2026-06-01"
last_accessed: "2026-06-01"
access_count: 8
---

# ADR: Rerank Top-50 Only

**Status:** Accepted · **Owner:** [[CRM/People/Katherine Johnson.md]]

Cap LLM reranking at the top 50 fused candidates. Beyond 50, recall gains were
inside the noise floor but latency and token cost grew linearly. Keeps
[[Projects/Helios Search.md]] p95 under 400ms.
