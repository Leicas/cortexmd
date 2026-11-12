---
type: memory
category: observation
temperature: warm
importance: medium
heat_score: 2
last_accessed: 2026-02-20
---
# Orbit CI flakiness

The Orbit integration tests fail intermittently when the mock clock crosses
midnight UTC; pinning the fake timer start to noon removes the flake.
