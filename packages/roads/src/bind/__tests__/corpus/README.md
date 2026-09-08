# Binding evaluation corpus

Each directory is one hand-verified case: a real event from a German feed, a
frozen OSM spine extract for its area, and what the resolver must produce.

## Capturing a case

1. Fetch a live record (e.g. `curl -s https://verkehr.autobahn.de/o/autobahn/A46/services/roadworks`)
   and pick one item. Run it through the parser
   (`packages/roads/src/autobahn.ts` `parseAutobahn`) or copy an already
   parsed observation from a running ingest's `/observations.geojson`.
2. Write `event.json` as a `BindInput`: `{ id, geometry, type, refs, direction?, roadState? }`.
   `refs` must be normalized (`normalizeRefs`). Note the source id and fetch
   date in `expected.json.why`.
3. Extract the spine: `pnpm --filter @openconditions/roads bind:spine <west> <south> <east> <north> > <case>/spine.json`
   (Overpass, same highway classes as the import, directed `f`/`b` segments
   exactly as `segment-build.ts` produces them). Keep the bbox tight (event
   bbox + ~1 km).
4. Verify BY HAND on osm.org: which ways, which carriageway, where it starts
   and ends. Write `expected.json`:
   `{ "status": "exact", "directionMode": "single", "segments": [{ "segmentId": "23456:f", "startFraction": 0.3, "endFraction": 1 }, ...], "why": "A46 eastbound between AS Grevenbroich and AK Neuss-West; ways confirmed on osm.org 2026-09-06; Autobahn roadworks id ..." }`
   Fractions are optional per segment (±0.05 tolerance when given).
5. Run `pnpm --filter @openconditions/roads bind:inspect <case-id>` and read
   the candidate table. If the resolver is wrong and you are right, keep your
   expectation — that is the point of the corpus.

## Required coverage (≥ 25 cases)

- Autobahn LineString closures on dual carriageways, both directions (≥ 6)
- Autobahn point-only warnings (≥ 3)
- DATEX endpoint pairs (MultiPoint of 2) from Mobilithek NRW and Bayern (≥ 6)
- Bundesstraße bidirectional line (≥ 3), including one sub-20 m line (`both`)
- Junction / link-road case (≥ 2)
- Inside a region on a non-imported class → `unresolved` (≥ 1)
- Outside every region → handled by the ingest stage, not the corpus
- Polygon weather warning → `not_applicable` (≥ 1)

## Known resolver bugs

Where the resolver contradicts a hand-verified case, the expectation stays as it
is — it is ground truth — and `expected.json` carries one extra field:

```json
"knownResolverBug": "one sentence saying what the resolver does instead"
```

The test then asserts that the marked case still _fails_, so fixing the resolver
turns it red until the marker is removed; removing the marker is part of the fix,
not a follow-up. Marked cases are counted in the aggregate metrics exactly like
every other case, so the thresholds always describe the whole corpus.

## Thresholds

`thresholds.json` holds the minimum aggregate metrics. Set each to the first
measured value minus 0.02; raise them as the resolver improves. The test
also fails when a metric exceeds its threshold by more than 0.05 so
improvements are recorded.
