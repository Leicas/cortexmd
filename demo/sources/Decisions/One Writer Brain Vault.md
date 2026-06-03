---
title: "ADR: Single-Writer Brain Vault"
tags: ["decision", "architecture", "adr"]
status: "accepted"
created: "2026-06-01"
last_accessed: "2026-06-01"
access_count: 12
---

# ADR: Single-Writer Brain Vault

**Status:** Accepted · **Owner:** [[CRM/People/Alan Turing.md]]

The MCP server is the *sole writer*. Source vaults are mounted read-only and
only ever indexed. This removes bidirectional-sync clobber hazards and is the
foundation for [[Projects/Agent Mesh.md]] sharing one memory across tools.
