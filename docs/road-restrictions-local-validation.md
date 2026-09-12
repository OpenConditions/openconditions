# Local validation: road restriction fidelity

How to validate the vehicle-restriction slices on a developer machine, and what
was observed when each was implemented. Nothing here needs a deployed stack, a
national database or a routing engine.

Two sources are covered. Finland's `fi-digitraffic` introduced the common
contract; the Netherlands' `nl-ndw` is a separately releasable slice that reuses
it without changing the wire version. Either source can run with the other
disabled.

## What the slice does

Finland's `fi-digitraffic` event feed reads the four supported Digitraffic v2
collections. Verified vehicle height, width, length and gross-weight limits are
normalized into an additive display contract, carried through OpenConditions'
publishers and the OpenMapX host provider, and shown with their phase or detour
scope, dates, source direction and rights.

NDW's `nl-ndw` event feed reads the national current-events DATEX II v3
snapshot. Verified vehicle applicability is taken only from a measure's own
`forVehiclesWithCharacteristicsOf` role: a height comparison, the `lorry` class
and the `emergencyServices` usage. Vehicles that are merely obstructing the road
or involved in an accident are participants and never become applicability.

A published number is a statement about the source, not a permission for a
particular vehicle to pass. NDW's height record says the event applies to
vehicles **taller than** 4.5 m; it is not a 4.5 m permitted maximum. Every
record carrying restriction evidence — valid, partial or unparseable — is
withheld from shared routing and from the DATEX and TraFF exporters, which
cannot represent its scope or comparator.

## Commands

Run in the OpenConditions checkout. Rebuild first: workspace exports resolve to
`dist`, so a stale build makes a red or green result meaningless.

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm --filter @openconditions/roads feeds:lint
```

Focused unit suites:

```sh
pnpm exec vitest run --project unit \
  packages/roads/src/__tests__/feeds.test.ts \
  packages/roads/src/__tests__/restrictions.test.ts \
  packages/roads/src/__tests__/snapshot.test.ts \
  packages/roads/src/__tests__/digitraffic.test.ts \
  packages/roads/src/__tests__/digitraffic-restrictions.test.ts \
  packages/roads/src/__tests__/datex.test.ts \
  packages/roads/src/__tests__/routing.test.ts \
  packages/roads/src/__tests__/decay-contract.test.ts \
  packages/roads/src/bind/__tests__ \
  packages/publishers/src/__tests__ \
  packages/core/src/__tests__/readObservations.test.ts \
  packages/core/src/__tests__/observationsByBbox.test.ts \
  integrations/road-conditions-openconditions/src/__tests__ \
  services/ingest/src/__tests__/run.test.ts \
  services/ingest/src/__tests__/resolve.test.ts \
  services/ingest/src/__tests__/write-postgis.test.ts \
  services/ingest/src/__tests__/smoke-road-restrictions.test.ts --no-cache
```

Disposable-PostGIS suites (Docker required):

```sh
pnpm exec vitest run --project integration \
  services/ingest/src/__tests__/road-snapshot.integration.test.ts \
  services/ingest/src/__tests__/restriction-lifecycle.integration.test.ts \
  services/ingest/src/__tests__/restriction-binding.integration.test.ts \
  services/ingest/src/__tests__/pipeline.integration.test.ts \
  services/ingest/src/__tests__/bind-observations.integration.test.ts \
  services/ingest/src/__tests__/publish-segment-conditions.integration.test.ts \
  services/ingest/src/__tests__/publish-routes-filters.integration.test.ts \
  services/ingest/src/__tests__/sweep.integration.test.ts --no-cache
```

In the OpenMapX checkout:

```sh
pnpm check-types
pnpm check-translations
pnpm exec vitest run --project node \
  packages/core/src/api/roadConditions.test.ts \
  packages/core/src/__tests__/roadRestrictionDetails.test.ts \
  packages/core/src/utils/__tests__/roadConditionRouting.test.ts \
  integrations/road-conditions/__tests__ \
  integrations/routing/road-condition-routing.test.ts \
  services/data-manager/src/__tests__/road-conditions-contract.test.ts --no-cache
pnpm exec vitest run --project web integrations/road-conditions/__tests__/map-layer.test.tsx --no-cache
```

## Optional live smoke

Finite and operator-run: one complete acquisition per invocation, no scheduler,
no loop.

```sh
pnpm exec tsx scripts/smoke-road-restrictions.ts \
  --source fi-digitraffic --output /tmp/oc-fi-restrictions-smoke

pnpm exec tsx scripts/smoke-road-restrictions.ts \
  --source fi-digitraffic --output /tmp/oc-fi-restrictions-db-smoke \
  --database disposable \
  --spine packages/roads/src/bind/__tests__/fixtures/finland-road40/spine.json

pnpm exec tsx scripts/smoke-road-restrictions.ts \
  --source nl-ndw --output /tmp/oc-ndw-restrictions-smoke

pnpm exec tsx scripts/smoke-road-restrictions.ts \
  --source nl-ndw --output /tmp/oc-ndw-restrictions-db-smoke \
  --database disposable \
  --spine packages/roads/src/bind/__tests__/fixtures/ndw-a76/spine.json
```

Each source uses its own reviewed spine. The disposable region takes its
timezone from the supplied graph rather than from the source's country, and the
read covers the whole throwaway database rather than one country's box.

The first mode validates acquisition, parsing, normalization and export safety
and writes `report.json` plus `display.geojson`. The second additionally creates
a throwaway PostGIS, imports the reviewed frozen spine, runs the real
`runSource` once and destroys the container. Neither mode writes to an ambient
database, and `DATABASE_URL` is ignored.

A restriction kind the current snapshot does not contain is reported as "not
observed", never as a failure: the pinned fixtures are the deterministic gate.
Transport, schema, normalization and publication-safety failures exit nonzero.

## Observed results, Finland slice, 2026-09-12

Runtime: Node v24.18.0, pnpm 11.1.3 (OpenConditions), pnpm 11.21.0 (OpenMapX),
Docker server 29.7.2.

| Check                                                             | Result                     |
| ----------------------------------------------------------------- | -------------------------- |
| OpenConditions `pnpm build` / `typecheck` / `lint` / `feeds:lint` | pass                       |
| OpenConditions unit suites (all packages/services/integrations)   | 208 files, 2391 tests pass |
| Restriction integration suites (disposable PostGIS)               | pass                       |
| OpenMapX `pnpm check-types` / `check-translations`                | pass                       |
| OpenMapX node + web road-condition suites                         | pass                       |
| Provider bundle import (`dist/backend/index.mjs`)                 | `setup` is a function      |
| Contract fixture copies (`cmp`)                                   | identical                  |
| Both working trees (`git diff --check`, `git status`)             | clean                      |

Suite counts from the release checkpoint: 41 focused OpenConditions unit files
(655 tests), 9 disposable-PostGIS integration files (109 tests), 19 OpenMapX
node files (225 tests) and 3 OpenMapX web files (42 tests) — all passing. The
Open511, WZDx, DATEX-TMC and spatial-dedupe suites were rerun because the
snapshot-reconciliation change touches shared parser dispatch; 4 files, 106
tests, unchanged.

Source terms rechecked at the Digitraffic terms-of-service page on 2026-09-12:
Creative Commons 4.0 BY, distribution and commercial reuse permitted with
attribution. Unchanged from the design review, so activation proceeded. All four
v2 collections answered HTTP 200 without credentials.

Live validation-only smoke against the production feed:

| Field                                             | Value                                         |
| ------------------------------------------------- | --------------------------------------------- |
| Input records                                     | 627                                           |
| Accepted / terminal / unlocatable                 | 627 / 0 / 0                                   |
| Records with restriction details                  | 80                                            |
| Restriction facts                                 | 102                                           |
| By kind                                           | width 62, gross weight 28, height 8, length 4 |
| By scope                                          | roadwork phase 76, detour 26                  |
| Issues                                            | conflicting direction 2                       |
| Unsupported envelopes                             | 0                                             |
| Withheld from segments / Valhalla / DATEX / TraFF | 80 each                                       |

These counts reproduce the design review's independent inspection of the same
feed (102 entries across 80 records; 62 width, 8 height, 4 length, 2 main-road
and 26 detour gross-weight; 76 phase and 26 detour scopes).

Disposable-database smoke against the same live feed and the frozen Road 40
spine: 627 rows published, 1 binding `exact`, 626 `no_coverage`, 80 conditional
records withheld, container removed. Almost everything is unbound because the
frozen graph covers about two kilometres of one road; that is the expected
result, not a defect.

## Observed results, NDW slice, 2026-09-12

Runtime: Node v24.18.0, pnpm 11.1.3 (OpenConditions), pnpm 11.21.0 (OpenMapX),
Docker server 29.7.2. OpenConditions `3f64c83`, OpenMapX `71606f76`.

| Check                                                             | Result                     |
| ----------------------------------------------------------------- | -------------------------- |
| OpenConditions `pnpm build` / `typecheck` / `lint` / `feeds:lint` | pass                       |
| OpenConditions unit suites (all packages/services/integrations)   | 218 files, 2512 tests pass |
| OpenConditions integration suites (disposable PostGIS)            | 67 files, 744 tests pass   |
| Focused NDW + shared unit set                                     | 40 files, 612 tests pass   |
| Focused restriction integration set                               | 8 files, 115 tests pass    |
| OpenMapX `check-types` (core, data-manager, api, web)             | pass                       |
| OpenMapX `check-translations`                                     | pass                       |
| OpenMapX node road-condition suites                               | 19 files, 240 tests pass   |
| OpenMapX web road-condition suites                                | 3 files, 43 tests pass     |
| Provider bundle import (`dist/backend/index.mjs`)                 | `setup` is a function      |
| Contract fixture copies (`cmp`)                                   | byte-identical             |

Source terms rechecked on 2026-09-12 at 16:50 UTC. The NDW copyright page
states Creative Commons Zero for site content unless a part declares an
exception, and excepts only images. No exception was found for this traffic XML
feed, and this work uses no NDW images. The endpoint answered HTTP 200 over
HTTPS without credentials.

Live validation-only smoke against the production feed:

| Field                                             | Value                                                   |
| ------------------------------------------------- | ------------------------------------------------------- |
| Input records                                     | 1443                                                    |
| Accepted / terminal / unlocatable                 | 1421 / 0 / 22                                           |
| Records with restriction details                  | 28                                                      |
| Restriction facts                                 | 18                                                      |
| By kind                                           | emergency-service usage 14, truck class 3, height 1     |
| By scope                                          | event road 18                                           |
| Issues                                            | conflicting direction 10, unknown vehicle 5, compound 1 |
| Unsupported envelopes                             | 0                                                       |
| Withheld from segments / Valhalla / DATEX / TraFF | 28 each                                                 |

The 18 facts across 18 applicability records reproduce the design review's
independent count of the same feed. The 22 unlocatable records are Alert-C-only
records with no companion location table; they are counted and excluded from
geometry-backed output rather than dropped silently.

The record that motivated this slice survives the full national snapshot:
`RWS01_M1080891_NARROW_LANES_D2_WWA` publishes as `road_closure` / `closed`
with a single fact reading height `gt` 4.5 m, metres, `event_applies_when`,
Alert-C `positive` / `aligned`, and `restrictionBinding: "not_established"`.
Before this slice it parsed in isolation but disappeared from full-feed output.

Weight, width and length are reported as "not observed in this snapshot". No
structured NDW value for those dimensions appeared in either the design capture
or this run, so the slice claims no live coverage for them.

Disposable-database smoke against the same live feed and the frozen A76 spine:
1416 rows published, 0 routable bindings (9 `ambiguous`, 10 `unresolved`, 1397
`no_coverage`), 28 conditional records withheld, container removed. Almost
everything is unbound because the frozen graph covers a few kilometres of one
motorway area; that is the expected result, not a defect.

Finland was revalidated after the shared smoke changes: validation-only run
accepted 629 records with 102 facts across 80 records, and the disposable run
published 629 rows with one `exact` binding and 80 conditional records withheld.
Neither source's descriptor or state touched the other, and the `nl-ndw-flow`
feed and its measurement-site table are unchanged.

### Graph binding is ambiguous, and stays that way

The height record supplies two GML endpoints, not a traced path. Against the
frozen A76 spine the matcher reports `ambiguous`, reproducing the design
review's probe. The tests assert that outcome rather than a candidate route, and
no threshold was lowered to force an exact match. The record remains fully
visible on the map with its binding status shown as unestablished.

## Fixtures and their provenance

| Fixture                                                                  | SHA-256                                                            | Rights                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------- |
| `packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json` | `859e917ace1c395132d8ff99e2db73b4eb0f645e425ac2023fa33110263b07da` | Fintraffic / Digitraffic, CC BY 4.0    |
| `packages/roads/src/bind/__tests__/fixtures/finland-road40/spine.json`   | `fcc4bf664bb8bed84f44f00a013a7900d0a9990ea3cbdb96a72616a310caf1dd` | © OpenStreetMap contributors, ODbL 1.0 |
| `packages/roads/src/__tests__/fixtures/ndw/restrictions-v3.xml`          | `42bd2e4572d1dc8053bad809b2a5d3c741af4dcfd8503035dc63839fcc70fe65` | NDW / Rijkswaterstaat, CC0 1.0         |
| `packages/roads/src/bind/__tests__/fixtures/ndw-a76/spine.json`          | `d2927f6c9c33e6b9214f6819133a4e128da168ac52d89af01c60dfa2ceca9a07` | © OpenStreetMap contributors, ODbL 1.0 |

Each has a companion `*.manifest.json` recording its source URL, capture time,
reductions and rights. The OSM spines are ODbL and are deliberately _not_
covered by the Fintraffic CC BY 4.0 or NDW CC0 grants, even though they are
exercised together.

The NDW fixture holds six real `situationRecord` elements reduced from the
reviewed capture, whose full decompressed snapshot hashed
`f774a3df6befacfde2389f68d8a34edb6b3a30e61e8f1ce54b6519f2e657b7ce`. Its six ids
are distinct and include two records with identical geometry, so identity-based
preservation is proved rather than assumed. Every status, recurrence, compound,
conflicting-direction and invalid-value variant is built by mutating that XML
inside a test and is labelled synthetic there.

The cross-repository contract fixture `road-restrictions-v1.json` is generated
from real producer code and copied to OpenMapX. Both repositories format with
the same Biome version and settings, so the copies are byte-identical, and both
contract tests parse the file so whitespace never reaches an assertion either
way:

```sh
cmp packages/publishers/src/__tests__/fixtures/contracts/road-restrictions-v1.json \
    ../openmapx/services/data-manager/src/__tests__/fixtures/contracts/road-restrictions-v1.json
```

Regenerate deliberately with `UPDATE_RESTRICTION_CONTRACT=1` (refused under
`CI`), run `pnpm format`, review the diff, then copy it across and run both
suites.

## Known limits

- Restriction extent is never bound. Every fact carries
  `restrictionBinding: "not_established"`, and the display says so. Matching the
  parent event to segments does not establish where a phase or detour limit
  applies.
- Source `pos`/`neg` directions are reference-system orientations and are never
  mapped to an OSM `f`/`b` direction.
- Working hours are display context only. A weight limit does not lapse when the
  crew goes home, so they never reach a fact's applicability schedule.
- A disconnected `MultiLineString` stays unbound with reason
  `disconnected_geometry` rather than being joined across the gap. Its source
  geometry is still published for display.
- The weight-restriction and exempted-transport collections were valid and empty
  at every check. Their event envelopes are handled; their restriction fields
  have no live sample yet, so those paths are covered by labelled synthetic
  tests.
- DATEX and TraFF omit restriction-bearing records entirely. Adding a second
  rule translator to those formats is out of scope for this slice.
- Road 7840 in the source fixture sits outside the default imported road
  classes, so its height limit binds to nothing. Widening the national road
  classes is a separate decision.
- NDW's live numeric coverage is height only. Weight, width and length appear in
  no observed structured record, so they stay partial source context and the
  legacy unconverted gross-weight number labelled kilograms is not carried
  forward for this source.
- NDW public comments mention truck and bus categories, 3500 kg and a
  scheduled-bus exception. That prose is preserved verbatim as publisher
  context; it is never converted into a weight threshold or an exemption rule.
- Only `greaterThan` is a verified NDW comparison operator. Other operators are
  exercised by labelled synthetic fixtures and remain `unsupported_operator`
  until a real record and authoritative unit documentation establish them.
- A DATEX measure is labelled active only when its operator action status is
  `implemented` and its validity status is recognized. `beingTerminated`, a
  missing status and an unfamiliar token all stay explicitly unknown.
- A DATEX calendar the schedule model cannot fully represent — a weekday
  recurrence or an exception period — yields `unsupported_schedule` and unknown
  temporal state rather than a simplified continuous rule.
- The NDW height record's two GML endpoints bind ambiguously against the frozen
  A76 spine. That is the honest limit of endpoint-only geometry, not a threshold
  to tune.

## Rollback

Disable the affected feed, or return to a previously validated v2 release. Do
not return to v1: it is deprecated and announced for removal after 2026-10-20.
A rollback never restores unconditional exports — the publication guards are
part of the contract, not an optional layer.

Source ids and existing rows are unchanged, so no data reset or migration is
needed. Ship the OpenMapX consumer, display and refresh support and the rebuilt
provider artifact before activating the producer, or restrictions travel with
nothing able to show them. Finland operates with NDW disabled.

For the NDW slice, roll back by disabling the `nl-ndw` event source or returning
to a previously validated restriction-aware NDW release. Keep the conservative
routing and export guards and the source freshness and orphan expiry in place: a
rollback must never re-enable the legacy recursive gross-weight extraction or
unconditional closure publication to restore apparent coverage. `nl-ndw` keeps
its id and rows, and the `nl-ndw-flow` feed is untouched, so no reset is needed.
NDW operates with Finland disabled and vice versa.

## Stop conditions

Stop and review rather than loosening semantics if the source terms change,
credentials become necessary, records go missing without an accounted
disposition, an all-empty snapshot is accepted as real, a direction or phase
scope is asserted without evidence, attribution is lost, a unit or comparator is
wrong, a stale view is labelled current, or **any** conditional record reaches
shared routing, DATEX or TraFF.

A valid empty source family, an unavailable optional live smoke, or an honestly
ambiguous event binding is a documented limit, not a reason to weaken the
contract.
