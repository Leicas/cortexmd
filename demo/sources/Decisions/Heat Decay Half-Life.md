---
title: "ADR: Heat Decay Half-Life = 14 days"
tags: ["decision", "memory", "adr"]
status: "accepted"
created: "2026-06-01"
last_accessed: "2026-06-03"
access_count: 10
---

# ADR: Heat Decay Half-Life = 14 days

**Status:** Accepted · **Owner:** [[CRM/People/Grace Hopper.md]]

Memory heat halves every 14 days absent access. Shorter half-lives archived
useful context too aggressively; longer ones kept stale notes "hot". Drives
[[Projects/Memory Lifecycle.md]] and the nightly dream archival pass.
