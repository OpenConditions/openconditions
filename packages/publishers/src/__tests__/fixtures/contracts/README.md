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
