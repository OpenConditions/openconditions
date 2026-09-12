# Local validation: Finland restriction fidelity

How to validate the Finnish vehicle-restriction slice on a developer machine,
and what was observed when it was implemented. Nothing here needs a deployed
stack, a national database or a routing engine.

## What the slice does

Finland's `fi-digitraffic` event feed reads the four supported Digitraffic v2
collections. Verified vehicle height, width, length and gross-weight limits are
normalized into an additive display contract, carried through OpenConditions'
publishers and the OpenMapX host provider, and shown with their phase or detour
scope, dates, source direction and rights.

A published number is a statement about the source, not a permission for a
particular vehicle to pass. Every record carrying restriction evidence — valid,
partial or unparseable — is withheld from shared routing and from the DATEX and
TraFF exporters, which cannot represent its scope or comparator.

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
```

The first mode validates acquisition, parsing, normalization and export safety
and writes `report.json` plus `display.geojson`. The second additionally creates
a throwaway PostGIS, imports the reviewed frozen spine, runs the real
`runSource` once and destroys the container. Neither mode writes to an ambient
database, and `DATABASE_URL` is ignored.

A restriction kind the current snapshot does not contain is reported as "not
observed", never as a failure: the pinned fixtures are the deterministic gate.
Transport, schema, normalization and publication-safety failures exit nonzero.

## Observed results, 2026-09-12

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
| Contract fixture copies compared as parsed JSON                   | equivalent                 |
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

## Fixtures and their provenance

| Fixture                                                                  | SHA-256                                                            | Rights                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------- |
| `packages/roads/src/__tests__/fixtures/digitraffic/v2-restrictions.json` | `859e917ace1c395132d8ff99e2db73b4eb0f645e425ac2023fa33110263b07da` | Fintraffic / Digitraffic, CC BY 4.0    |
| `packages/roads/src/bind/__tests__/fixtures/finland-road40/spine.json`   | `fcc4bf664bb8bed84f44f00a013a7900d0a9990ea3cbdb96a72616a310caf1dd` | © OpenStreetMap contributors, ODbL 1.0 |

Each has a companion `*.manifest.json` recording its source URL, capture time,
reductions and rights. The OSM spine is ODbL and is deliberately _not_ covered
by the Fintraffic CC BY 4.0 grant, even though the two are exercised together.

The cross-repository contract fixture `road-restrictions-v1.json` is generated
from real producer code and copied to OpenMapX. Each repository formats its own
copy, so the two agree as parsed JSON rather than byte for byte. Compare them
that way:

```sh
diff <(jq -S . packages/publishers/src/__tests__/fixtures/contracts/road-restrictions-v1.json) \
     <(jq -S . ../openmapx/services/data-manager/src/__tests__/fixtures/contracts/road-restrictions-v1.json)
```

Both contract tests parse the file, so whitespace never reaches an assertion.

Regenerate deliberately with `UPDATE_RESTRICTION_CONTRACT=1` (refused under
`CI`), run `pnpm format`, review the diff, then copy it across, format it in
OpenMapX and run both suites.

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

## Rollback

Disable the affected feed, or return to a previously validated v2 release. Do
not return to v1: it is deprecated and announced for removal after 2026-10-20.
A rollback never restores unconditional exports — the publication guards are
part of the contract, not an optional layer.

Source ids and existing rows are unchanged, so no data reset or migration is
needed. Ship the OpenMapX consumer, display and refresh support and the rebuilt
provider artifact before activating the producer, or restrictions travel with
nothing able to show them. Finland operates with NDW disabled.

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
