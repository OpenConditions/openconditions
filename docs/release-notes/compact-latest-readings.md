# Compact latest observation storage

Affected versions: Unreleased source builds containing the compact latest-reading writer and its decoder. No product version is assigned by this change.

Action: None. Normal service startup applies the database migrations, which install the PostgreSQL reconstruction function, before the writer starts. New readings gradually adopt the compact representation; their first conversion replaces the series template once.

Compatibility: Full API records, measurement times, history, rollups and contributor receipts are preserved. The decoder accepts both representations. When rolling back application images, keep the new decoder: restoring the old decoder would expose incomplete records for compact rows that remain. No full-table rewrite or configuration change is needed.

Caveats: Initial conversion is not steady-state write behavior. WAL savings were measured on NDW row shapes; sources that frequently change shared metadata replace their templates and may see different results. See [the measurement and rollout notes](../observation-write-load.md) for the retained benchmark and production comparison procedure.
