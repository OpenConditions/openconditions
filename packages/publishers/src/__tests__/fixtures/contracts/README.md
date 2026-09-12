# OpenConditions → OpenMapX contract fixture

`road-conditions-v1.input.json` is a synthetic bound-observation input. The
publisher contract test calls `segmentConditionsToJson` with its frozen clock
and compares the entire result with `road-conditions-v1.json`.

The same output payload is checked into OpenMapX at
`services/data-manager/src/__tests__/fixtures/contracts/road-conditions-v1.json`.
Its consumer contract test exercises parsing, directed graph mapping, provenance,
source exclusions, expiry and ambiguous bindings. Both tests run in their normal
repository test suites; neither requires the other checkout or a live feed.

For intentional contract changes, update and review both fixture copies and run
both suites. Compare parsed JSON, since the repositories use different formatters.
Do not refresh timestamps to today's date or regenerate the expected output as
part of a test: the fixed clock and independent golden output detect drift.

All observations, sources and road identities here are authored test data. The
licence fields exercise provenance handling; they do not assert rights for an
actual upstream source.

## `road-restrictions-v1.json`

The normalized vehicle-restriction display contract, version 1. Unlike the two
fixtures above it has no `.input.json`: it is produced entirely from real
producer code by `buildRestrictionContractFixture` in the OpenConditions host
provider's tests — the actual GeoJSON publisher, the actual host projection and
the actual `segmentConditionsToJson` emitter, all at the frozen instant
`2026-09-11T12:00:00.000Z`.

The wrapper carries `displayEvents` (what OpenMapX shows), `segmentConditions`
(what a routing consumer receives) and `expectedConditionalIds` (records that
must produce zero routing effects). It pairs one unconditional control closure
with one conditional Finnish record, so a consumer test proves both that the
control still applies and that the restriction-bearing record does not.

The conditional graph row is **synthetic**: the eligible control row with its
identity and attributes replaced by the actual normalized restriction event,
keeping every other eligibility condition satisfied. The producer test also
emits that same row with only its restriction evidence removed and asserts it
does publish, so the exclusion is attributable to the restriction guard rather
than to rights, binding currency or evidence.

The same payload is checked into OpenMapX at
`services/data-manager/src/__tests__/fixtures/contracts/road-restrictions-v1.json`.
Regenerate deliberately with `UPDATE_RESTRICTION_CONTRACT=1` (refused under
`CI`), review the diff, copy it to OpenMapX and run both suites.

The Fintraffic record is real reviewed source data under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/); the control closure is authored
test data whose licence fields only exercise provenance handling.
