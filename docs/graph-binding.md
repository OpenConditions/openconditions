# Graph binding

A road event arrives from a feed as geometry: a point, a start/end pair of
coordinates, or a polyline that a publisher drew somewhere near the road it is
talking about. That is enough to draw a marker on a map and nowhere near enough
to close a carriageway for a router, which needs to know _which_ directed piece
of _which_ OSM way is affected.

**Binding** is the derived step that answers that question. It resolves an event
against the directed segment spine (`conditions.road_segment`, one row per
`way_id:f|b`) and stores the ordered spans the event occupies, each with the
fraction range along the segment, plus a confidence and a status describing how
sure the resolver is.

Binding never rewrites the event. `conditions.observations.geom` stays exactly
as the publisher sent it, and the binding lives in its own tables alongside it.
That matters for three reasons: the original geometry is what the map draws and
what an archive consumer expects; a resolver bug can be corrected by re-running
the resolver rather than by re-fetching a feed that may no longer serve the
record; and a consumer that disagrees with the binding can always fall back to
the raw geometry.

## The two tables

Both live in the `conditions` schema, created by migration
`0025_observation_binding.sql`.

`conditions.observation_binding` — one row per attempted event, keyed by
`observation_id`:

| column                   | meaning                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                 | binding outcome (see below)                                                                                                                                                                     |
| `confidence`             | 0..1, `NULL` when nothing was resolved                                                                                                                                                          |
| `direction_mode`         | `single` / `both` / `unknown`                                                                                                                                                                   |
| `candidate_count`        | spine segments the resolver considered: distinct segments for a line or a point, but the sum of the start and end candidates for an endpoint pair (a segment matched at both ends counts twice) |
| `alternative_confidence` | the confidence the runner-up would have carried, `NULL` if uncontested                                                                                                                          |
| `reason`                 | short machine reason on a non-binding outcome                                                                                                                                                   |
| `resolver_version`       | `RESOLVER_VERSION` at the time of writing                                                                                                                                                       |
| `geom_hash`              | hash of the resolver inputs, used for change detection                                                                                                                                          |
| `bound_at`               | when the row was written                                                                                                                                                                        |

`conditions.observation_segment` — the ordered path, primary key
`(observation_id, seq)`, carrying `segment_id`, `way_id`, `dir`,
`start_fraction` and `end_fraction`.

Both tables cascade from `conditions.observations`, so deleting an observation
takes its binding with it. Neither has a foreign key to
`conditions.road_segment`: the weekly rebuild deletes and reinserts a region's
segments inside one transaction, and a cascade there would wipe every binding in
the region once a week. The rebuild re-binds instead, and prunes the path rows
whose segment genuinely disappeared.

## The resolver

The resolver lives in `packages/roads/src/bind/` and is pure: geometry and
stated road references in, ordered directed spans out. No I/O and no database —
SQL only fetches the spine subgraph and stores the outcome, which is what makes
the evaluation corpus possible. The entry points are `bindEvent(input, spine,
opts)` and `toBindInput(event)`, both exported from `@openconditions/roads`.

Tuning constants (`BIND_DEFAULTS` in `packages/roads/src/bind/types.ts`):

| constant              | default | meaning                                                |
| --------------------- | ------- | ------------------------------------------------------ |
| `maxOffsetM`          | 40 m    | candidate search radius around a sample                |
| `sampleSpacingM`      | 25 m    | spacing when densifying a line into samples            |
| `minBearingLengthM`   | 20 m    | lines shorter than this have no usable bearing         |
| `maxSubgraphSegments` | 5000    | upper bound on the spine subgraph loaded for one event |

### Applicability

- Only `kind = "event"`, `domain = "roads"`, `status = "active"` rows are
  attempted.
- Polygon and MultiPolygon geometry is `not_applicable` / `polygon_geometry` —
  an area warning must never become a road closure.
- The types `weather`, `public_event`, `authority`, `security` and
  `transit_disruption` are `not_applicable` / `area_type`. Everything else is
  attempted, including `congestion`, `accident` and `hazard`.
- An event whose bbox lies outside every configured spine region is
  `no_coverage` / `outside_regions`. That is decided by the ingest stage rather
  than the resolver: it is an operator's region-list choice, not a failure of
  the maths.

### Pipeline

1. **Sample points.** A point is used as-is. A line is densified to ≤ 25 m
   spacing. A MultiPoint of exactly two points is an _endpoint pair_ (the DATEX
   `linearByCoordinates` start/end shape); with more points it is treated as a
   line in the given order.
2. **Candidates per sample.** Every spine segment whose perpendicular offset is
   ≤ `maxOffsetM`. Each candidate records its offset, its fraction along the
   segment and the local segment bearing.
3. **Score per candidate**, all terms in 0..1:
   - `offset`: `1 − offset / maxOffset`
   - `bearing` (line samples only): `1` up to a 30° difference, falling linearly
     to `0` at 90°. Beyond 90° the candidate scores 0 and is dropped — that is
     the wrong carriageway.
   - `ref`: `1` on a stated match, `0.5` when either side states no ref, `0` on
     a stated mismatch. Refs are compared as normalized sets: uppercased,
     whitespace and hyphens stripped, split on `;`, `,` and `/`, so `"A 46"`,
     `"A46"` and `"a-46"` are one ref and `"B 9;B 56"` is two.
   - `class`: a prior by OSM `highway` (motorway 1.0 … primary_link 0.8), so a
     motorway beats its parallel link road at equal geometry.

   Combined as `0.4·offset + 0.3·bearing + 0.2·ref + 0.1·class`. A point sample
   has no bearing, and its weight is folded into the offset term
   (`0.7·offset + 0.2·ref + 0.1·class`).

4. **Path reconstruction** over a directed adjacency of the subgraph (segment A
   → B when A's last coordinate is B's first):
   - _Line or ordered points:_ take the best candidate per sample, walk the
     samples in order, and bridge consecutive samples that landed on different
     segments with a bounded Dijkstra. Path cap `1.5 × event length + 200 m`.
   - _Endpoint pair:_ Dijkstra between the two projections, restricted to
     segments whose ref matches when the event states one, cap
     `2.5 × straight-line + 500 m` and a hard maximum of 30 km. The top 3 start
     × top 3 end candidates are tried and the best-scoring path kept.
   - _Single point:_ the best candidate only, span `[fraction, fraction]`.
5. **Fractions.** The first segment's `start_fraction` is the projection of the
   event start, the last segment's `end_fraction` the projection of the event
   end; every segment in between is `[0, 1]`.
6. **Confidence.**
   `0.4·coverage + 0.2·(1 − meanOffset/maxOffset) + 0.2·refScore + 0.1·directionCertainty + 0.1·(1 − ambiguity)`,
   where `coverage` is the share of samples within `maxOffset` of the chosen
   path, `directionCertainty` is 1 for `single`, 0.5 for `both` and 0 for
   `unknown`, and `ambiguity` is the best rejected score divided by the chosen
   one. For an endpoint pair the runner-up path's ratio is scaled by the share
   of road it does _not_ have in common with the winner, so the same path
   entered from the previous way is a continuation (ambiguity ≈ 0), a parallel
   road a full rival, and a partial detour sits in between. A binding whose
   carriageway stayed undecided is capped at **0.69**, so it can never reach a
   routing-relevant status.
7. **Status.** `exact` when confidence ≥ 0.9 and ambiguity < 0.8, `likely`
   when confidence ≥ 0.7 and ambiguity < 0.9, otherwise `ambiguous`. The
   ambiguity ceiling on `likely` is what keeps a coin flip between two
   equally good roads off the routing graph however well the winner fits. No
   candidates and no path are failures with a reason.

`alternative_confidence` is `ambiguity × confidence` — what the runner-up would
have scored had it won. It is `NULL` when nothing competed for the event, and is
the number to look at when deciding whether a binding is worth a manual check.

### Rivals

Not every rejected candidate is a competitor. The next way along the same
carriageway is a _continuation_: consecutive ways share a node, while opposite
carriageways of a dual carriageway never do. A candidate therefore counts as a
**rival** only when it sits on a different way, shares no node with the chosen
one, and the event's own stated ref did not strictly beat it — matching refs,
two mismatches, or a refless event all leave the choice open, so the candidate
stays a rival and drives `ambiguity`. Segments already on the chosen path are
never rivals.

### Statuses

| status           | reason               | meaning                                                                                                 |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `exact`          | —                    | confidence ≥ 0.9 and ambiguity < 0.8; safe for routing                                                  |
| `likely`         | —                    | confidence ≥ 0.7 and ambiguity < 0.9; safe for routing                                                  |
| `ambiguous`      | —                    | a path was found but it is contested or weakly supported; published for the map and QA, not for routing |
| `unresolved`     | `no_candidates`      | inside a region but nothing within `maxOffsetM` — typically a road class the spine does not import      |
| `unresolved`     | `no_path`            | both endpoints matched but no connected route between them                                              |
| `unresolved`     | `subgraph_too_large` | the spine subgraph exceeded `maxSubgraphSegments`                                                       |
| `unresolved`     | `resolver_error`     | the resolver threw; recorded rather than retried, never fatal                                           |
| `no_coverage`    | `outside_regions`    | the event's bbox is outside every configured spine region                                               |
| `not_applicable` | `area_type`          | `weather`, `public_event`, `authority`, `security`, `transit_disruption`                                |
| `not_applicable` | `polygon_geometry`   | Polygon / MultiPolygon geometry                                                                         |

Consumers that steer routes narrow to `exact` and `likely`. `ambiguous` exists
so that a human, a map layer or a QA pass can see what the resolver was unsure
about instead of the record vanishing.

### Direction modes

A dual carriageway in OSM is two separate oneway ways, each yielding only an `f`
segment, so the bearing test picks the carriageway. A single bidirectional way
yields an `f` and a `b` segment carrying the same line in the opposite vertex
order (the `b` geometry is stored reversed, so both run in travel direction).

| mode      | when                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single`  | one carriageway, decided — either uncontested, or the chosen segment's heading fits at least 30° better than every rival's at every sample. An endpoint pair (MultiPoint of 2) is always reported `single`: the Dijkstra path between the two matched endpoints fixes the travel direction, so no bearing test runs |
| `both`    | a bidirectional way with no usable heading: a point, or a line under 20 m. Both directions are bound, two spans per way                                                                                                                                                                                             |
| `unknown` | contested and undecidable: a bearing-less line, or a point whose nearest carriageway has a rival. The nearest one still wins, but confidence is capped at 0.69 so routing never closes a guessed side                                                                                                               |

The free-text `direction` attribute a feed may carry is part of the change hash
but is not interpreted.

## When binding runs

- **After every swap.** `services/ingest/src/pipeline/bind-observations.ts` runs
  as a stage after a non-flow source's atomic swap has committed, over exactly
  the ids that changed (`SwapCounts.changedIds`). It runs _after_ the commit so
  a slow resolve never holds the advisory lock, and a failure is logged and
  swallowed — binding is derived data and must never fail a poll.
- **At startup.** `rebindStale` in `services/ingest/src/pipeline/rebind.ts`
  hands every bindable id to the stage, fire-and-forget, so neither the feed
  pollers nor the HTTP server wait on it. It force-deletes nothing: the stage's
  own change detection decides what is stale, so a boot with nothing to do
  reports 0.
- **On a resolver bump.** The same startup pass covers it. A binding is
  re-resolved when its input hash changed _or_ its stored `resolver_version` is
  no longer `RESOLVER_VERSION`, so raising the constant in
  `packages/roads/src/bind/types.ts` is all it takes to re-resolve the store on
  the next boot.
- **After the weekly spine rebuild.** `rebindAll` is the fifth and last stage of
  `runSegmentRebuild` (`SEGMENT_REBUILD_CRON`), after OSM import, segment build,
  OpenLR encode and sensor snap. This pass _forces_ a re-resolve, because a
  rebuilt spine renumbers segments under events whose own inputs never moved and
  the stage would otherwise skip them all as unchanged. It then deletes any path
  row still pointing at a segment the rebuild removed.

Both rebind passes are no-ops when `BIND_ENABLED=false`; they bail before
touching anything, so turning the stage off can never strip bindings that
nothing would put back.

The change hash covers every input the resolver reads: geometry, normalized
refs, event type, the free-text direction and `roadState`. Type is in there
because `bindEvent` short-circuits on the not-applicable types — an event whose
type flips to `weather` must lose its spans rather than be skipped as unchanged.

Bindings are dropped for ids that are no longer active road events. A swap can
flip `observations.status` to `inactive` in place instead of deleting the row,
and the cascade only fires on a real delete; without the explicit clear an ended
closure would keep its `exact` binding and its spans forever.

## `GET /segments/conditions.json`

The routing consumer's feed: bound, in-effect road events keyed by directed OSM
way spans. Instance-wide (no bbox, like `/segments/speed.csv`), rate-limited,
`Cache-Control: public, max-age=60`, share-alike rows removed and
`X-Data-License` set from the surviving rows.

Query parameter: `at=<ISO 8601>`, defaulting to now. A malformed value is a 400. Only `active` events with an `exact`, `likely` or `ambiguous` binding are
selected, and each is then filtered through `isInEffectAt` — the coarse
`validFrom`/`validTo` span and the schema.org `schedule` **intersect**, so `at`
must fall inside the span _and_, when a schedule is present, inside one of its
occurrences (evaluated in the schedule's own `scheduleTimezone`). A nightly
closure is therefore absent from the feed during the day. SQL cannot express
that, which is why the filter runs in the emitter.

The payload is snake_case throughout:

```json
{
  "generated_at": "2026-09-06T10:00:00.000Z",
  "at": "2026-09-06T10:00:00.000Z",
  "resolver_version": "1.0.0",
  "conditions": [
    {
      "id": "autobahn:…",
      "source": "autobahn-de",
      "type": "road_closure",
      "severity": "high",
      "road_state": "closed",
      "speed_limit_kph": null,
      "vehicles_affected": [],
      "origin_kind": "feed",
      "routing_eligible": true,
      "valid_from": "2026-09-06T04:00:00.000Z",
      "valid_to": "2026-09-08T16:00:00.000Z",
      "binding": { "status": "exact", "confidence": 0.96, "direction_mode": "single" },
      "segments": [
        {
          "way_id": 23456,
          "dir": "f",
          "start_fraction": 0.31,
          "end_fraction": 1,
          "geometry": {
            "type": "LineString",
            "coordinates": [
              [6.58, 51.09],
              [6.6, 51.1]
            ]
          }
        },
        {
          "way_id": 23457,
          "dir": "f",
          "start_fraction": 0,
          "end_fraction": 0.68,
          "geometry": {
            "type": "LineString",
            "coordinates": [
              [6.6, 51.1],
              [6.62, 51.11]
            ]
          }
        }
      ]
    }
  ]
}
```

`geometry` is the occupied part of the directed segment, cut with
`ST_LineSubstring(road_segment.geom, start_fraction, end_fraction)`. The
segment's stored geometry already runs in travel direction (it is reversed for
`dir = 'b'`), so the cut does too. Three details are worth knowing:

- A **point-located** event binds to a zero-length span, and `ST_LineSubstring`
  on an empty range returns a `Point`. The cut is therefore widened by 10 m
  either side of the fraction, so `geometry` is always a `LineString` or `null`
  and never a `Point`. The emitted `start_fraction` and `end_fraction` stay
  equal and truthful about where the event actually is.
- `geometry` is **`null`** when the span's segment no longer exists in
  `road_segment`. The binding tables carry no FK to the spine, so a rebuild can
  drop a segment out from under a still-valid binding; the span comes through
  with a null geometry rather than vanishing.
- `routing_eligible` is honoured verbatim for `origin_kind: "crowd"` rows (an
  unconfirmed report must not steer a route) and forced to `true` for every
  other origin, because a feed row's own column defaults to `false` in the
  schema and would otherwise suppress whole authoritative feeds.

Consumers that steer routes should narrow to `binding.status` of `exact` or
`likely`.

## `binding` and `segments` on the read path

`readObservations` and `observationsByBbox` in `@openconditions/core` take an
`includeBindings` option. It splices a LEFT JOIN onto `observation_binding` plus
a lateral aggregate over `observation_segment` into the query; without it the
default query is byte-for-byte unchanged and the fields are absent rather than
null.

The shared `read()` helper behind the emitter routes sets it for every one of
them, and because the GeoJSON emitter carries the whole model into `properties`,
a bound `/observations.geojson` feature gains:

```json
{
  "binding": { "status": "exact", "confidence": 0.96, "directionMode": "single" },
  "segments": [
    { "segmentId": "23456:f", "wayId": 23456, "dir": "f", "startFraction": 0.31, "endFraction": 1 }
  ]
}
```

These are camelCase — the canonical model's `ObservationBinding` and
`SegmentSpan` shapes. snake_case appears only in `/segments/conditions.json`.
The XML emitters and the Valhalla exclusions project named fields and simply
ignore the extra ones.

`integrations/road-conditions-openconditions` maps them onto
`RoadConditionEvent.binding` and `.segments`, and also forwards
`vehiclesAffected` off the attributes. All three are optional: an instance that
has not bound an event, or has binding turned off, simply omits them.

## `/feeds/status` metrics

Each feed entry gains a `binding` object counting the outcomes of that source's
events:

```json
{
  "id": "autobahn-de",
  "binding": {
    "attempted": 1420,
    "exact": 1103,
    "likely": 214,
    "ambiguous": 61,
    "unresolved": 30,
    "noCoverage": 12,
    "notApplicable": 0
  }
}
```

`attempted` is the total of all stored bindings for the source, including any
status this reader does not recognise, so it stays truthful if the resolver ever
grows an outcome. The counts come from one `GROUP BY` cached for 60 s, so
polling the status page is cheap. The key is omitted entirely for a feed with no
bindings, and a failed metrics read is logged and degrades the whole endpoint to
no `binding` keys rather than failing it.

The ratio to watch is `unresolved / attempted`. A sudden rise usually means the
feed started publishing on a road class the spine does not import (see
`SEGMENT_HIGHWAY_CLASSES`), not that the resolver regressed.

`noCoverage` reads differently: it means the events fell outside every imported
region, which is a configuration answer rather than a resolver one. The default
`SEGMENT_REGIONS` covers NL, SE, FI and US-NY and does **not** include Germany,
so a German feed binds nothing at all until the region is added — if `noCoverage`
dominates a feed's counts, set `SEGMENT_REGIONS` to the regions that feed
actually publishes in.

## Configuration

| variable                  | default                                                        | meaning                                                                                          |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `BIND_ENABLED`            | `true`                                                         | run the binding stage; `false` also disables both rebind passes                                  |
| `BIND_MAX_OFFSET_M`       | `40`                                                           | candidate search radius in metres                                                                |
| `BIND_CONCURRENCY`        | `8`                                                            | events resolved in parallel per stage run                                                        |
| `SEGMENT_HIGHWAY_CLASSES` | `motorway,motorway_link,trunk,trunk_link,primary,primary_link` | OSM `highway` values the spine imports, shared by the osmium filter and the Overpass query       |
| `SEGMENT_REGIONS`         | NL, SE, FI, US-NY                                              | JSON array of the regions whose spine is imported; an event outside all of them is `no_coverage` |
| `SEGMENT_REBUILD_CRON`    | `0 4 * * 1`                                                    | when the spine rebuild (and with it the forced full rebind) runs; `off` disables it              |

`SEGMENT_REGIONS`, `SEGMENT_HIGHWAY_CLASSES` and the three `BIND_*` knobs are
all declared in `services/ingest/service.json`, so a Compose-rendered deployment
passes them through from the host environment, so setting them there is enough.

All of these except `SEGMENT_REBUILD_CRON` are read per call rather than cached,
so a changed value takes effect on the next stage run. `SEGMENT_REBUILD_CRON` is
read once when the scheduler starts and registers its job, so changing it needs
a restart.

An empty string counts as unset throughout, so Compose's `${VAR:-}`
unset-injection behaves like an absent variable. A non-positive or unparseable
`BIND_MAX_OFFSET_M` / `BIND_CONCURRENCY` falls back to its default rather than
disabling the stage.

Widening `SEGMENT_HIGHWAY_CLASSES` (for example with `secondary`) lets urban
roadworks bind, at the cost of spine size. Only values matching `[a-z_]+` are
accepted, so a typo can never inject regex metacharacters into the Overpass
query or a flag into osmium's argv.

## The evaluation corpus

`packages/roads/src/bind/__tests__/corpus/` holds 30 hand-verified German cases,
each a directory with three files: `event.json` (the `BindInput`), `spine.json`
(a frozen Overpass spine extract for the area) and `expected.json` (what the
resolver must produce, plus a `why` recording how it was verified). Because the
resolver is pure, every case replays offline and deterministically.

The suite asserts each case individually and then checks four aggregate metrics
against `thresholds.json` — `statusAccuracy`, `segmentPrecision`,
`segmentRecall` and `wrongDirectionRate`. The check is a **ratchet in both
directions**: a metric below its threshold fails, and a metric that beat its
threshold by more than 0.05 fails too, with a message telling you to update
`thresholds.json`. Improvements therefore get recorded instead of quietly
banking headroom.

A case whose hand-verified expectation the resolver does not yet reproduce
carries a `knownResolverBug` field with one sentence saying what the resolver
does instead. The expectation stays as it is — it is ground truth — and the test
asserts that the marked case still _fails_. Fixing the resolver turns that case
red until the marker is removed, which makes removing it part of the fix rather
than a follow-up. Marked cases count towards the aggregate metrics like every
other case, so the thresholds always describe the whole corpus.

Two scripts support the work:

```bash
# explain one decision: chosen path, aggregate fit, per-sample candidate table
pnpm --filter @openconditions/roads bind:inspect a44-ratingen-schwarzbach-north

# freeze a spine extract for a new case (west south east north)
pnpm --filter @openconditions/roads bind:spine 6.55 51.05 6.70 51.15 > spine.json
```

`bind:inspect` also takes an explicit `<event.json> <spine.json>` pair, which is
the fastest way to debug a live event that is not (yet) a corpus case.

The full recipe for capturing a case, including the required coverage targets,
is in
[`packages/roads/src/bind/__tests__/corpus/README.md`](../packages/roads/src/bind/__tests__/corpus/README.md).

## Consumer limitation: whole-way fallback

A span is a fraction range along an OSM way, and a router's graph is made of
edges, not ways. Nothing in a routing graph's way-to-edge index carries the
order or the length of a way's edges, so fractions alone cannot pick the edges
inside a span. A consumer has to map-match the span `geometry` onto its own
graph to recover them.

When that match fails — the router is unreachable, the trace times out, it
returns no edge that cross-checks against the expected way and direction — the
correct fallback is **every edge of the way in the bound direction**. That
over-closes: a 200 m closure on a 4 km way suppresses the whole way for that
direction. It is the safe failure, in that it never leaves a real closure
unapplied, but a consumer should count how often it happens rather than treat it
as normal.

Partial edges are not expressible for routing either, so the first and last edge
of a span are closed whole.
