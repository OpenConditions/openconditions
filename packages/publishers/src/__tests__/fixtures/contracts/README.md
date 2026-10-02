# OpenConditions → OpenMapX contract fixtures

The routing wire contract, schema version 2: `/segments/conditions.json` lists
one condition per routable or restriction-evidence effect of a bound road
situation, with its routing evidence.

`road-conditions-v2.input.json` (a full closure) and
`road-speed-cap-v2.input.json` (a temporary speed limit) are synthetic bound
effect rows, as `readSegmentConditionRows` returns them. The publisher
contract test calls `segmentConditionsToJson` with their frozen clock and
compares the entire result with `road-conditions-v2.json` and
`road-speed-cap-v2.json`.

`road-restrictions-v2.json` pairs the closure with the vehicle-specific
effects the real parsers produce: the NDW records of
`packages/roads/src/__tests__/fixtures/ndw/restrictions-v3.xml` (a height
condition, an emergency-service usage and two lorry closures) and the
Fintraffic weight limit of `…/digitraffic/weight-restriction.json`. Each
restriction row is the eligible closure row with its identity,
classification and effect replaced, and the effect's own window dropped so
every one is evaluated at the frozen instant. The test also proves that none
of them excludes a car route or caps its speed.

The same payloads are checked into OpenMapX at
`services/data-manager/src/__tests__/fixtures/contracts/`. Its consumer
contract tests exercise parsing, directed graph mapping, provenance, source
exclusions, expiry, vehicle scope and restriction evidence. Both tests run in
their normal repository test suites; neither requires the other checkout or a
live feed.

For an intentional contract change, regenerate with `UPDATE_CONTRACTS=1`
(refused under `CI`), run `pnpm format`, review the diff, copy the three
output files to OpenMapX and run both suites. Do not refresh timestamps to
today's date: the fixed clock and the golden output detect drift.

The closure, the speed limit and the road identities are authored test data;
their licence fields only exercise provenance handling. The Fintraffic
record is real reviewed source data under CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/) and the NDW records are real
reviewed source data under CC0 1.0
(https://creativecommons.org/publicdomain/zero/1.0/).
