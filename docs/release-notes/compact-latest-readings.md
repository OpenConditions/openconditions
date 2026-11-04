# Compact latest observation storage

Latest observations store less repeated metadata while preserving their full API records, measurement times, history, rollups and contributor receipts. Migration 0091 replaces the PostgreSQL reconstruction function without rewriting existing rows or changing server settings. New readings gradually adopt the compact representation; their first conversion replaces the series template once.

Apply the bundled migration before starting the new writer. Normal service startup does this automatically. When rolling back application images, keep the new decoder: it reads both formats, whereas restoring the old decoder would expose incomplete records for compact rows that remain. No full-table rewrite or configuration change is needed. See [the measurement and rollout notes](../observation-write-load.md) for the benchmark and production comparison procedure.
