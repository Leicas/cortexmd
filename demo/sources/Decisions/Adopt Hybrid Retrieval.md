---
title: "ADR: Adopt Hybrid Retrieval"
tags: ["decision", "search", "adr"]
status: "accepted"
created: "2026-04-12"
last_accessed: "2026-06-03"
access_count: 16
---

# ADR: Adopt Hybrid Retrieval

**Status:** Accepted · **Owner:** [[CRM/People/Ada Lovelace.md]]

Combine BM25 (MiniSearch) with vector similarity, fused via Reciprocal Rank
Fusion. Pure semantic missed exact-symbol queries; pure lexical missed
paraphrases. Hybrid won every slice of the eval set.

Applies to [[Projects/Helios Search.md]]. Superseded the BM25-only baseline.
