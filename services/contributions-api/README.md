# @openconditions/contributions-api

Crowd-contribution service for OpenConditions: enrollment and Privacy Pass
tokens, intake of signed crowd reports and votes, the evidence each crowd
report earns, the reviewer surface, and the federation inbox.

This package is AGPL-3.0-or-later (a deployable network-commons server, like
`services/ingest`), in contrast to the Apache-2.0 reusable libraries it builds
on (`@openconditions/core`, `model`, `contrib-core`).

## Crowd reports

- `POST /contrib/reports` — a signed model claim. A situation claim lands as a
  situation record of the `crowd` source (`landClaim`, then the write seam),
  with its first `report` evidence row; its evidence decides when it ends
  (`freshness.expiresAt`). The answer names the record, `{class, id}`, with its
  `evidenceState` and `routingEligible`. Observation claims answer
  `422 unsupported_claim_class` until observations are stored as series.
- `POST /contrib/reports/{class}/{id}/{confirm|negate|flag}[?component=]` — a
  signed vote whose subject names the route's record. Votes take situations.
- Evidence (`recomputeEvidence`): a replayable projection of the ledger onto
  the situation's `evidence_state`, `confidence_score`, `routing_eligible`,
  `corroborations` and expiry, under the kind's crowd rules.
- Agreement: a report merges with an independent crowd report of the same
  phenomenon (`situationsAgree`; the later one is tombstoned `superseded`), and
  is routed when one of this instance's own feeds publishes the same situation.
- Reviewer: `GET /contrib/reviewer/flagged`,
  `POST /contrib/reviewer/{class}/{id}/{accept|reject}`, the block list.

## Federation inbox

`@openconditions/contributions-api/federation/inbox` lands a peer's outbox page
record by record (`admitFederatedRecord`, then the write seam); a peer's crowd
report goes through the same evidence and agreement as a local one. The
federation service's `POST /peer/inbox` calls it. `eraseRecord` is the
operator's erasure (see `docs/federation-gdpr.md`).
