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
  `evidenceState` and `routingEligible`.
- An observation claim (a charge point's status, a fuel price, a car park's
  occupancy) lands on the canonical feature and canonical component its
  subject stands for (`feature_canonical`, which a per-source or a canonical
  feature id both resolve through), at the survivor's location, as a crowd row
  of `observation_latest` beside the feeds' rows; the subject's fused rows
  (`@fused` and, where needed, `@fused-public`) are recomputed. A place (a
  regional fuel price) is accepted only where a feed already publishes that
  property for it, and takes that series' location. The
  answer is `{record: {class: "observation", id}, evidenceState}`. A replay is
  recognised by the key and nonce (`report_evidence.details.localId`); a
  second key reporting the same reading of the same subject at the same
  instant confirms it, and a different result is refused with
  `409 conflicting_report`. A report about a subject this instance does not
  hold is `422 unknown_subject`. Crowd readings are never federated: their
  subject is this instance's canonical feature.
- `POST /contrib/reports/{class}/{id}/{confirm|negate|flag}[?component=]` — a
  signed vote whose subject names the route's record. Votes take situations
  and crowd observations (by the observation's record id); a flag on an
  observation is recorded only.
- Evidence (`recomputeEvidence`, `recomputeObservationEvidence`): a
  replayable projection of the ledger onto the situation's (or the crowd
  observation row's) `evidence_state`, `confidence_score`, `corroborations` and
  expiry, under the kind's or property's crowd rules. An observation's
  evidence state is its fusion tier.
- Agreement: a report merges with an independent crowd report of the same
  phenomenon (`situationsAgree`; the later one is tombstoned `superseded`), and
  is routed when one of this instance's own feeds publishes the same situation.
  A crowd reading is resolved (`official_match`, which trains the reporter)
  when a feed of this instance published the same reading of any member of its
  canonical subject in force when it was made, or within its lifetime
  (`observationConfirms`); the cross-validation sweep retries live readings.
- Reviewer: `GET /contrib/reviewer/flagged`,
  `POST /contrib/reviewer/{class}/{id}/{accept|reject}`, the block list.

## Federation inbox

`@openconditions/contributions-api/federation/inbox` lands a peer's outbox page
record by record (`admitFederatedRecord`, then the write seam); a peer's crowd
report goes through the same evidence and agreement as a local one. The
federation service's `POST /peer/inbox` calls it. `eraseRecord` is the
operator's erasure (see `docs/federation-gdpr.md`).

## Configuration

| Variable                               | Meaning                                                                                | Default                            |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| `DATABASE_URL`                         | PostgreSQL/PostGIS connection URL. Required.                                           | none                               |
| `OPENCONDITIONS_GRANT_SECRET`          | HMAC secret signing reporting grants. Required in production.                          | ephemeral outside production       |
| `OPENCONDITIONS_REVIEWER_TOKEN`        | Bearer token of the reviewer surface. Required in production.                          | ephemeral outside production       |
| `OPENCONDITIONS_ISSUER_NAME`           | TokenChallenge issuer name.                                                            | `contributions.openconditions.org` |
| `OPENCONDITIONS_CROSS_VALIDATE_SWEEP`  | `off` stops the sweep that retries cross-validation of unresolved crowd reports.       | on                                 |
| `OPENCONDITIONS_INSTANCE_ID`           | This instance's id, the namespace of the crowd records it lands; the ingest service's. | `local`                            |
| `OPENCONDITIONS_CROWD_LICENSE`         | Licence of this instance's crowd reports (an id of the licence registry).              | `ODbL-1.0`                         |
| `OPENCONDITIONS_CROWD_SOURCE_URI`      | Link the crowd's credit carries.                                                       | none                               |
| `OPENCONDITIONS_ALLOW_POLICE_CATEGORY` | `true` lets crowd reports of police presence land.                                     | off                                |

Each of the three secrets may instead be a file named by `<KEY>_FILE`. Under
OpenMapX the service is a community service whose `container.environment`
reaches the container verbatim, so `service.json` declares these as
`configSchema` fields. The secrets are vault secrets the operator sets once in
the admin services panel (`openconditions-contributions-api`, Credentials);
OpenMapX mounts each as a file and sets `<KEY>_FILE`. On the shared OpenMapX
database `DATABASE_URL` is
`postgresql://postgres:<POSTGRES_PASSWORD>@postgis:5432/openmapx`. The
settings are set in the same panel, or as
`SERVICE_OPENCONDITIONS_CONTRIBUTIONS_API_<KEY>` in OpenMapX's `.env`.
Settings kept in OpenMapX's `.env` are applied with
`pnpm openmapx services start openconditions-contributions-api` (which resets
every setting saved only in the admin form, so keep all of them in one place).
Settings saved in the form are applied with **Save & Apply**.
