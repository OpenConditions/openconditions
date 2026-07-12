# @openconditions/contributions-api

Crowd-contribution service for OpenConditions: intake of signed crowd reports and
sub-claims, and recomputation of an observation's materialized evidence state
from its authoritative `report_evidence` ledger.

This package is AGPL-3.0-or-later (a deployable network-commons server, like
`services/ingest`), in contrast to the Apache-2.0 reusable libraries it builds
on (`@openconditions/core`, `contrib-core`, `roads`).

Current surface:

- `recomputeEvidence(sql, observationId, now)` — replayable projection of the
  evidence ledger onto `evidence_state` / `routing_eligible` /
  `confidence_score` / `expires_at`, wrapping core's pure `evaluateEvidence`.

HTTP routes (Fastify) land in a later task.
