---
type: memory
category: decision
temperature: warm
importance: high
heat_score: 4
last_accessed: 2026-01-10
---
# Lumen database choice

For the Lumen invoicing prototype we chose SQLite with WAL mode over Postgres:
single-node deployment, no ops budget, and the dataset stays under 2 GB.
Revisit if multi-writer sync is ever needed.
