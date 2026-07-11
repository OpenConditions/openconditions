# Commons substrate

The "commons substrate" is the shared identity, evidence, decay, and privacy
plumbing that every forthcoming data-commons feature — crowd reporting,
federation, publishing emitters, probe aggregation — builds on instead of
reinventing. It landed as six additions: a migration on
`conditions.observations`, `packages/core`'s `canonical.ts` and
`evidence.ts`, `packages/roads`'s `decay.ts`, `packages/core`'s
`observed-properties.ts`, and the provenance-stamping seam in
`services/ingest/src/pipeline/normalize.ts`.

This page is the consumer-readiness check: every field and function below has
at least one named downstream consumer, so nothing here is speculative or
orphaned. "Consumer" means either an already-wired call site (`normalize.ts`
today) or the feature area that is designed to call it next — those calls
don't exist yet, but the substrate's shape is fixed by the contract they need.

## `conditions.observations` columns (migration `0007_commons_observation_fields`)

| Column                         | Purpose                                                                          | Downstream consumer(s)                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance_id`                  | The federated instance that wrote the row.                                       | Federation (outbox scopes what it exports by originating instance; a receiving instance uses it to tell local rows from mirrored ones).                                            |
| `canonical_id`                 | Exact, source-stable record identity (collapses re-supplies of the same record). | Federation (dedup keys on `canonical_id` across instances); crowd reporting (fusion key grouping repeat reports of one record).                                                    |
| `phenomenon_fingerprint`       | Candidate-generation key for "may describe the same real-world phenomenon".      | Federation (fingerprint candidate matching before a cross-instance merge); crowd reporting (finds existing observations a new report might corroborate).                           |
| `replaces`                     | Canonical ids this observation supersedes.                                       | Federation (supersession chain when a merged/updated condition replaces an earlier one).                                                                                           |
| `corroborations`               | Ids of independent observations that corroborate this one.                       | Crowd reporting (evidence ledger corroboration trail feeding `evaluateEvidence`).                                                                                                  |
| `fuzziness`                    | How precisely the geometry/extent is known.                                      | Crowd reporting (deliberately coarsened report geometry, e.g. a device's approximate location); publishing emitters (flag degraded-precision geometry to consumers).               |
| `confidence_score`             | Normalized `[0,1]` presentation ranking.                                         | Crowd reporting (contributions-api reads it to rank/display reports; written by `evaluateEvidence`); publishing emitters (`confidenceEnum` maps it to the wire `Confidence` enum). |
| `severity_level`               | Numeric 1–5 severity, when a controller assigns a graded level.                  | Publishing emitters (STA/SIRI severity mapping needs a graded level, not just the `Severity` string enum).                                                                         |
| `privacy_class`                | The privacy tier an observation was produced under.                              | Federation (outbox filters/redacts by `privacy_class` before a row leaves the instance); probe aggregation (marks `k_anon`/`dp_noised` rows).                                      |
| `k_anonymity`                  | `k` for k-anonymity, when the observation is a k-anonymized aggregate.           | Probe aggregation (the aggregation batch size backing a `k_anon` row).                                                                                                             |
| `dp_epsilon`, `dp_delta`       | Differential-privacy budget spent, when DP-noised.                               | Probe aggregation (accounting for a `dp_noised` row's noise parameters).                                                                                                           |
| `informed`                     | Transit entities (modes/routes/stops/trips) this observation informs.            | Publishing emitters (STA/SIRI `InformedEntity`/affected-route wiring).                                                                                                             |
| `source_uri`, `source_license` | Canonical URI and SPDX license of the upstream record.                           | Publishing emitters (attribution passthrough); federation (attribution carried across an instance boundary).                                                                       |

The four indexes (`idx_conditions_obs_canonical`, `idx_conditions_obs_phenomenon`,
`idx_conditions_obs_instance`, `idx_conditions_obs_privacy`) exist for the same
lookups: federation and crowd reporting both query by `canonical_id` and
`phenomenon_fingerprint`, federation's outbox filters by `instance_id` and
`privacy_class`. The seven `CHECK` constraints (range/enum bounds on
`confidence_score`, `dp_epsilon`, `dp_delta`, `k_anonymity`, `severity_level`,
`fuzziness`, `privacy_class`) are the last line of defence against a bad row
from any of those consumers reaching the table at all.

Note: these are the generic `conditions.observations` privacy columns.
Probe aggregation's own per-segment continuous-measurement table
(`segment_observation`) is a **separate** table added by the probe plan's own
migration — it is not part of this substrate and isn't covered here.

## `packages/core/src/canonical.ts`

| Export                   | Purpose                                                              | Downstream consumer(s)                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonicalId`            | Hashes a namespace + record id into the stable `canonical_id`.       | Ingest pipeline (`normalize.ts`, already wired — stamps every feed row); federation (dedup key); crowd reporting (fusion key).                                                                                                          |
| `canonicalIdentityParts` | Extracts the `(namespace, recordId)` pair `canonicalId` hashes.      | Federation (constructs the same namespace a receiving instance must reproduce to match rows).                                                                                                                                           |
| `normalizeNamespace`     | Idempotent NFC-lowercase normalization of a namespace string.        | Federation (namespace comparison across instances must be case/normalization-insensitive).                                                                                                                                              |
| `phenomenonFingerprint`  | Hashes grid cell + type + time bucket into a candidate-matching key. | Ingest pipeline (`normalize.ts`, already wired — stamps every event row with a `validFrom`); federation (candidate matching before merge); crowd reporting (finds nearby-in-space/time/type candidates a new report might corroborate). |

## `packages/core/src/evidence.ts`

| Export                  | Purpose                                                                              | Downstream consumer(s)                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluateEvidence`      | Replays a report's evidence ledger into a state, `confidenceScore`, and expiry.      | Crowd reporting (the contributions-api's core policy call: turns raw report/confirm/negate/external entries into what gets shown and for how long). |
| `updateReliability`     | Updates a reporter's Beta reliability posterior from an externally resolved outcome. | Crowd reporting (trains reporter reputation only off official/reviewer/objective resolutions, never peer agreement).                                |
| `reliabilityLowerBound` | One-sided lower credible bound of a reliability posterior.                           | Crowd reporting (feeds `evaluateEvidence`'s optional `reporterLowerBound` advisory adjustment).                                                     |
| `shrinkToward`          | Shrinks a reliability posterior toward a cohort prior (inactivity decay).            | Crowd reporting (an inactive reporter's reputation decays back toward the cohort average over time).                                                |
| `confidenceEnum`        | Maps a `confidenceScore` to the wire `Confidence` enum.                              | Crowd reporting / publishing emitters (display and export both need the categorical enum, not the raw score).                                       |

## `packages/roads/src/decay.ts`

| Export                                 | Purpose                                                                            | Downstream consumer(s)                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_DECAY_TTLS`, `FALLBACK_DECAY` | Per-type crowd/feed TTL and corroboration-extension ceiling policy table.          | Crowd reporting (`decayTtlSec`/`decayMaxLifetimeSec` feed `EvidencePolicy.ttlSec`/`maxLifetimeSec`); federation (bounded TTL is the primary GDPR data-minimisation mitigant for a row crossing an instance boundary). |
| `decayTtlSec`                          | The effective TTL in seconds for a `(type, origin)`, honouring operator overrides. | Crowd reporting (builds the `EvidencePolicy` passed to `evaluateEvidence`).                                                                                                                                           |
| `decayMaxLifetimeSec`                  | The corroboration-extension ceiling in seconds for a type.                         | Crowd reporting (same `EvidencePolicy` construction).                                                                                                                                                                 |
| `expiresAtFor`                         | Derives an ISO expiry from `dataUpdatedAt` plus the `(type, origin)` TTL.          | Feed ingest (fallback `expiresAt` for the rare official row with no explicit `validTo`/expiry of its own).                                                                                                            |

## `packages/core/src/observed-properties.ts`

| Export                | Purpose                                                                                         | Downstream consumer(s)                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OBSERVED_PROPERTIES` | Seeded, frozen registry of every known `${domain}/${type-or-metric}` with its unit/description. | Publishing emitters (STA/SIRI unit and description strings per observed property); probe aggregation (new probe-produced metrics register here so they don't sprawl into unregistered attribute keys). |
| `observedKey`         | The registry key `${domain}/${type-or-metric}` for an observation.                              | Ingest pipeline (`normalize.ts`, already wired — used to build the warn-once dedupe key); publishing emitters (looks up the registry entry for a given observation).                                   |
| `validateObserved`    | Warn-only registry + attribute-key-sprawl validation; never throws or mutates.                  | Ingest pipeline (`normalize.ts`, already wired — logs a rate-limited warning, ingestion proceeds regardless).                                                                                          |

## `services/ingest/src/pipeline/normalize.ts`

`normalizeObservation` is the single write choke point that stamps
`instance_id`, `canonical_id`, `phenomenon_fingerprint`, `source_uri`, and
`source_license` onto every observation before it is persisted, and rejects
any parser-supplied `privacy_class`/`instance_id`/`k_anonymity`/`dp_epsilon`/
`dp_delta` as a bug. It is already the live consumer of `canonicalId`,
`phenomenonFingerprint`, `validateObserved`, and `observedKey` — every other
row in the tables above names a feature area that has not landed yet, but
whose contract this normalization seam and the columns/functions above are
already shaped to serve.
