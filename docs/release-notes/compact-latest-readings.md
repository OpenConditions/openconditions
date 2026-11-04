# Compact latest observation storage

Affected versions: Unreleased source builds containing migration 0091 and the compact latest-reading writer. No product version is assigned by this change.

Action: Apply the bundled migration before starting the new writer. Normal service startup does this automatically. Migration 0091 replaces the PostgreSQL reconstruction function without rewriting existing rows or changing server settings. New readings gradually adopt the compact representation; their first conversion replaces the series template once.

Compatibility: Full API records, measurement times, history, rollups and contributor receipts are preserved. The decoder accepts both representations. When rolling back application images, keep the new decoder: restoring the old decoder would expose incomplete records for compact rows that remain. No full-table rewrite or configuration change is needed.

Caveats: Initial conversion is not steady-state write behavior. WAL savings were measured on NDW row shapes; sources that frequently change shared metadata replace their templates and may see different results. See [the measurement and rollout notes](../observation-write-load.md) for the retained benchmark and production comparison procedure.
