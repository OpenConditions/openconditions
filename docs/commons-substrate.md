# Commons substrate

The "commons substrate" is the shared identity, evidence, decay, and privacy
plumbing that every forthcoming data-commons feature — crowd reporting,
federation, publishing emitters, probe aggregation — builds on instead of
reinventing. It is `packages/core`'s `canonical.ts` and `evidence.ts`,
`packages/contrib-core`'s evidence policy, and
the identity, privacy and provenance columns every model record table carries.
The soft observed-property registry that once sat beside them is replaced by
the hard-validating model registry ([model.md](model.md)).

This page is the consumer-readiness check: every field and function below has
at least one named downstream consumer, so nothing here is speculative or
orphaned. "Consumer" means either an already-wired call site or the feature
area that is designed to call it next.

## Record columns

The record tables (`situation`, `feature`, `offer`) and the observation series
(`observation_latest`) carry the substrate's identity and privacy fields as
promoted columns beside the sealed record ([storage.md](storage.md)):
`instance_id` (the instance that sealed the record), `canonical_id` (the
record's own federation identity, `sha256([namespace, localId])`; the
cross-source cluster lives in `feature_canonical`), `privacy_class`, and on
situations the crowd evidence state and presentation score. The record body
keeps the rest of the provenance (attribution, rights, reporter, raw payload
reference), so the commons fields travel with a record across federation.
Records are sealed by the model's write seam (`sealRecord`), which derives the
canonical id (`canonicalIdOf` in `@openconditions/model`).

## `packages/core/src/canonical.ts`

| Export          | Purpose                                                                 | Downstream consumer(s)                                                                   |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `centroid`      | Vertex mean of a geometry: the stable cheap point for a quantized key.  | Crowd reporting (landing places a report; the kinematic check measures between reports). |
| `coarseCell`    | A ~1 km grid cell of a point (`gridCell` at 1000 m), for abuse buckets. | Crowd reporting (the rate limiter counts reports per key per cell).                      |
| `isoUtcEpochMs` | ISO-shaped instant to epoch ms, offset-less times pinned to UTC.        | Crowd reporting (the kinematic check's report interval).                                 |

## `packages/core/src/evidence.ts`

| Export                  | Purpose                                                                              | Downstream consumer(s)                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluateEvidence`      | Replays a report's evidence ledger into a state, `confidenceScore`, and expiry.      | Crowd reporting (the contributions-api's core policy call: turns raw report/confirm/negate/external entries into what gets shown and for how long). |
| `updateReliability`     | Updates a reporter's Beta reliability posterior from an externally resolved outcome. | Crowd reporting (trains reporter reputation only off official/reviewer/objective resolutions, never peer agreement).                                |
| `reliabilityLowerBound` | One-sided lower credible bound of a reliability posterior.                           | Crowd reporting (feeds `evaluateEvidence`'s optional `reporterLowerBound` advisory adjustment).                                                     |
| `shrinkToward`          | Shrinks a reliability posterior toward a cohort prior (inactivity decay).            | Crowd reporting (an inactive reporter's reputation decays back toward the cohort average over time).                                                |
| `confidenceEnum`        | Maps a `confidenceScore` to the wire `Confidence` enum.                              | Crowd reporting / publishing emitters (display and export both need the categorical enum, not the raw score).                                       |

## `packages/contrib-core/src/evidence-policy.ts`

| Export                     | Purpose                                                                                                            | Downstream consumer(s)                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `EVIDENCE_POLICY_DEFAULTS` | The per-state presentation scores, reliability weight and asymmetric peer-confirmation constants.                  | Crowd reporting (every evidence policy carries them).                                                                    |
| `crowdEvidencePolicy`      | Builds the `EvidencePolicy` for a kind and type, or a property, from the registry's crowd rules (`crowdRulesFor`). | Crowd reporting (the contributions-api's recompute: lifetime, corroboration ceiling and quorums come from the registry). |
