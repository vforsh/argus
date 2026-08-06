# Google Sheets typed mutation refactoring

Status: implemented for the safe inspection/query/diff/apply scope.

The plugin now has one versioned semantic apply model with text/number/boolean/formula/null-clear values, rectangular `setRange`, sparse `setCells`, native clear, raw UI-copy type verification plus exact formula-source verification, full-manifest preflight, immediate per-step preconditions, dry-run, journal, and rollback generation. Decimal numbers use exact temporary arithmetic formulas followed by values-only conversion, avoiding locale-dependent paste parsing. Empty clipboard writes and optional verification are rejected. UI operations remain sequential and explicitly non-atomic.

Coordinate safety, page-scoped leases, bounded gid traversal, target/restored metadata, semantic row insertion, key-based updates, and bulk structural mutations were implemented alongside the typed engine because they are prerequisites for safe mutation.

Format-only copying from the earlier proposal is intentionally outside this task's P0/P1 command scope and remains unimplemented. Private Google `batchexecute` APIs remain prohibited.
