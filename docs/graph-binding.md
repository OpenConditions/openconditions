# Graph binding

A road situation arrives from a feed with a location: a point, a start/end pair
of coordinates, or a polyline that a publisher drew somewhere near the road it
is talking about. That is enough to draw a marker on a map and nowhere near
enough to close a carriageway for a router, which needs to know _which_ directed
piece of _which_ OSM way is affected.

**Binding** is the derived step that answers that question. It resolves a
location against the directed segment spine (`conditions.road_segment`, one row
per `way_id:f|b`) and stores the ordered spans the location occupies, each with
the fraction range along the segment, plus a confidence and a status describing
how sure the resolver is.

Binding never rewrites the record. A situation's `location` (and the `geom`
column promoted from it) stays exactly as the publisher sent it, and the binding
lives in its own tables alongside it. That matters for three reasons: the
original geometry is what the map draws and what an archive consumer expects; a
resolver bug can be corrected by re-running the resolver rather than by
re-fetching a feed that may no longer serve the record; and a consumer that
disagrees with the binding can always fall back to the raw geometry.

## What is bound

The binder places live (not tombstoned) situations of the `roads` domain
([model](model.md)). One situation can have several bound locations:

- **The situation's own location**, when it has a geometry. Its binding has
  `effect_id` `''`.
- **Each effect that names a geometry of its own** in `effect.location`: a
  roadworks phase closing a different stretch, a detour, a lane closure the
  source located separately. Its binding is keyed by the effect's id.

An effect without a `location` applies where its situation does and reads the
situation's binding. An effect whose own location has only a description and no
geometry applies somewhere the situation's binding does not establish, so it
reads no binding at all and never reaches the routing outputs.

## The tables

All three live in the `conditions` schema, created by migrations
`0042_record_bindings.sql` and `0044_record_binding_queue.sql`. Each is keyed by
`(record_class, record_id, effect_id)`; `record_class` is `situation` for every
row the binder writes, and `effect_id` is `''` for a record's own location.

`conditions.record_binding` — one row per location the resolver attempted:

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
| `record_revision`        | the record revision the binding was computed from                                                                                                                                               |
| `graph_generation`       | the spine generation (`road_graph_state.generation`) it was computed on                                                                                                                         |
| `bound_at`               | when the row was written                                                                                                                                                                        |

`conditions.record_segment` — the ordered path, primary key
`(record_class, record_id, effect_id, seq)`, carrying `segment_id`, `way_id`,
`dir`, `start_fraction` and `end_fraction`.

`conditions.binding_queue` — durable binding work, one row per situation whose
revision changed (`effect_id` `''` covers the situation and all its effects),
with the `record_revision` it was queued for, `attempts`, `next_attempt_at` and
`last_error`.

A summary row and its spans are always replaced together in one transaction, and
only while the situation is still live at the revision the result was computed
from and the graph is still the generation it was computed on. A reader never
sees a new status with an old path.

None of the tables has a foreign key. The record classes are separate tables, so
the binder drops the bindings of a tombstoned situation or of an effect that is
gone, and the sweep removes the bindings and queued work of a purged record. Nor
is there a foreign key to `conditions.road_segment`: the weekly rebuild deletes
and reinserts a region's segments inside one transaction, and a cascade there
would wipe every binding in the region once a week. The rebuild re-binds
instead, and prunes the path rows whose segment genuinely disappeared.

## The resolver

The resolver lives in `packages/roads/src/bind/` and is pure: geometry and
stated road references in, ordered directed spans out. No I/O and no database —
SQL only fetches the spine subgraph and stores the outcome, which is what makes
the evaluation corpus possible. The entry points are `bindEvent(input, spine,
opts)` and `toBindInput(location)`, both exported from `@openconditions/roads`.

The binder (`services/ingest/src/pipeline/bind-records.ts`) builds one input per
location: the location's geometry, the situation's `kind` as `type`, the refs
and first names of `location.roads`, and the direction (the axis value
`positive` / `negative` when the location states one, else the source's text).
An effect's own location is resolved with the situation's roads and direction.

Tuning constants (`BIND_DEFAULTS` in `packages/roads/src/bind/types.ts`):

| constant              | default | meaning                                                |
| --------------------- | ------- | ------------------------------------------------------ |
| `maxOffsetM`          | 40 m    | candidate search radius around a sample                |
| `sampleSpacingM`      | 25 m    | spacing when densifying a line into samples            |
| `minBearingLengthM`   | 20 m    | lines shorter than this have no usable bearing         |
| `maxSubgraphSegments` | 5000    | upper bound on the spine subgraph loaded for one event |

### Applicability

- Only live situations of the `roads` domain are attempted, and only while the
  road graph is `ready`.
- Polygon and MultiPolygon geometry is `not_applicable` / `polygon_geometry` —
  an area warning must never become a road closure.
- The situation kinds `weather_condition`, `public_event`, `authority` and
  `security` are `not_applicable` / `area_type` (`NOT_APPLICABLE_TYPES` in
  `packages/roads/src/bind/bind-event.ts`). Everything else is attempted,
  including `congestion`, `incident` and `road_hazard`.
- A location whose bbox lies outside every configured spine region is
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
| `no_coverage`    | `outside_regions`    | the location's bbox is outside every configured spine region                                            |
| `not_applicable` | `area_type`          | `weather_condition`, `public_event`, `authority`, `security`                                            |
| `not_applicable` | `polygon_geometry`   | Polygon / MultiPolygon geometry                                                                         |
| `obsolete`       | —                    | computed on a graph that is being rebuilt or replaced, or by a forced rebind; waiting to be re-resolved |

The routing outputs read only `exact` and `likely`. `ambiguous` exists so that a
human, a map layer or a QA pass can see what the resolver was unsure about
instead of the record vanishing. `obsolete` is written by the ingest service,
not the resolver: the old spans stay until their replacement is written, but no
reader applies them.

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

The location's `direction` is part of the change hash but is not interpreted.

## When binding runs

- **After every publish.** The writer (`writeSnapshotIn` in
  `@openconditions/storage`) queues every situation whose revision changed,
  tombstones included, in `binding_queue` inside the poll's own transaction, so
  a revision is never visible without its binding work. After each feed poll,
  event or flow (flow feeds derive congestion situations), the scheduler drains
  the queue with `drainBindingQueue` in
  `services/ingest/src/pipeline/bind-records.ts`: up to 500 due situations per
  drain, outside the poll's transaction, so a slow resolve never holds the
  source's advisory lock. A failed drain is logged and swallowed — binding is
  derived data and must never fail a poll.
- **Retries.** A resolver error is stored as `unresolved` / `resolver_error`
  and the situation stays queued with backoff (30 s doubling, at most an hour).
  A result that could not be written stays queued as it is. Everything else is
  acknowledged up to the revision now stored, so work queued for a newer
  revision in the meantime stays.
- **At startup.** `rebindOnBoot` in `services/ingest/src/pipeline/rebind.ts`
  runs fire-and-forget, so neither the feed pollers nor the HTTP server wait on
  it. When every stored binding carries the current `RESOLVER_VERSION`, it hands
  every live road situation to the binder and lets change detection decide, so a
  boot with nothing to do reports 0. When any binding carries another version,
  it rebinds everything (`rebindAll`): raising the constant in
  `packages/roads/src/bind/types.ts` is all it takes to re-resolve the store on
  the next boot.
- **When the graph changes.** A spine rebuild marks every binding `obsolete`
  and queues every live road situation before it touches a graph table.
  Activating the new graph marks the bindings of any other generation
  `obsolete` and queues every live road situation again. Until the graph is
  `ready`, the binder writes nothing.
- **After the weekly spine rebuild.** `rebindAll` is the last stage of
  `runSegmentRebuild` (`SEGMENT_REBUILD_CRON`), after OSM import, segment build,
  OpenLR encode, sensor snap and graph activation. This pass _forces_ a
  re-resolve, because a rebuilt spine renumbers segments under situations whose
  own inputs never moved and the binder would otherwise skip them all as
  unchanged. It then deletes any path row still pointing at a segment the
  rebuild removed.

The binder writes nothing when `BIND_ENABLED=false`, and both rebind passes bail
before touching anything, so turning the stage off can never strip bindings that
nothing would put back.

A location is skipped as unchanged when its input hash, the resolver version,
the record revision and the graph generation all match the stored binding and
the binding is not `obsolete`. The hash covers every input the resolver reads
plus what the location means for traffic: geometry, normalized refs, the
situation kind, the direction and the kinds of the situation's effects. The kind
is in there because `bindEvent` short-circuits on the not-applicable kinds — a
situation whose kind flips to `weather_condition` must lose its spans rather
than be skipped as unchanged.

Bindings are dropped for locations that are no longer live: a tombstoned
situation, or an effect that no longer names its own geometry. A situation that
returns binds from scratch.

## Routing outputs

Two routes in `services/ingest/src/publish-routes.ts` turn bindings into
routing input. Both read through `readSegmentConditionRows` in
`@openconditions/core` and project with `segmentConditionsToJson` in
`@openconditions/publishers`, so they apply the same gates.

### `GET /segments/conditions.json`

The routing consumer's feed, schema version 2: one condition per bound effect,
keyed by directed OSM way spans. Rate-limited, `Cache-Control: public,
max-age=60`, share-alike records and unscheduled catalogue children removed, and
`X-Data-License` set from the surviving rows.

Query parameters: `at=<ISO 8601>`, defaulting to now, and an optional
`bbox=west,south,east,north` that selects effects by their own geometry. A
malformed value is a 400.

A condition is read when all of these hold:

- The situation is live, of the `roads` domain and not past its expiry.
- The effect is of a routing kind (`closure`, `lane_restriction`,
  `speed_limit`, `access`, `dimension_limit`, `hazmat`), or it is restriction
  evidence (its vehicles are unknown or it is not fully normalized).
- The location it applies to has an `exact` or `likely` binding computed by the
  current `RESOLVER_VERSION` on the active, `ready` graph generation. That is the
  effect's own binding when it names its own geometry, else the situation's.
- The effect is in force at `at`: `effectStateAt` evaluates the effect's own
  validity, else its situation's, including any schedule, in the schedule's own
  timezone. A roadworks phase is therefore listed only during its phase, and a
  nightly closure is absent during the day. SQL cannot express that, which is
  why the filter runs in the publisher.
- A crowd effect's situation is `routing_eligible`; a feed effect always may
  route.
- Its routing evidence is complete: source check time, freshness deadline,
  licence and rights, and spans that all still have a geometry. Anything
  missing drops the condition — the feed fails closed.

A restriction-evidence effect is listed with `routing_evidence.reason_codes`
saying why it may not constrain shared routing, and never routes. Every other
condition is listed only when its evidence passes `routingEvidenceReasons`.

The payload is snake_case at the top; `effect` is the model effect itself:

```json
{
  "schema_version": 2,
  "complete": true,
  "generated_at": "2026-09-06T10:00:00.000Z",
  "at": "2026-09-06T10:00:00.000Z",
  "resolver_version": "2.0.0",
  "conditions": [
    {
      "id": "oc:situation:de-autobahn-a46-closure:…#…/closure",
      "record_id": "oc:situation:de-autobahn-a46-closure:…",
      "effect_id": "…/closure",
      "source": "de-autobahn-a46-closure",
      "kind": "closure",
      "type": "closure",
      "subtype": "full",
      "severity": "major",
      "effect": {
        "id": "…/closure",
        "kind": "closure",
        "v": 1,
        "scope": "road",
        "applicability": { "kind": "all" },
        "compliance": "mandatory",
        "normalization": "complete"
      },
      "origin": "feed",
      "evidence_state": null,
      "routing_eligible": true,
      "binding": { "status": "exact", "confidence": 0.96, "direction_mode": "single" },
      "routing_evidence": {
        "schema_version": 2,
        "record_class": "situation",
        "record_id": "oc:situation:de-autobahn-a46-closure:…",
        "effect_id": "…/closure",
        "record_revision": 3,
        "binding_revision": 3,
        "effect_kind": "closure",
        "graph_generation": "…",
        "resolver_version": "2.0.0",
        "valid_from": "2026-09-06T04:00:00.000Z",
        "valid_to": "2026-09-08T16:00:00.000Z",
        "next_transition_at": "2026-09-08T16:00:00.000Z",
        "direction_mode": "forward",
        "applicability": { "kind": "all" },
        "binding_status": "exact",
        "reason_codes": [],
        "…": "source, licence, rights, freshness and the spans"
      },
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

- A **point-located** effect binds to a zero-length span, and
  `ST_LineSubstring` on an empty range returns a `Point`. The cut is therefore
  widened by 10 m either side of the fraction, so `geometry` is a `LineString`
  and never a `Point`. The emitted `start_fraction` and `end_fraction` stay
  equal and truthful about where the effect actually is.
- A span whose segment no longer exists in `road_segment` has no geometry. The
  binding tables carry no FK to the spine, so a rebuild can drop a segment out
  from under a binding; the reader returns that span with a `null` geometry,
  and the publisher drops the whole condition rather than route on part of it.
- `routing_eligible` is honoured verbatim for `origin: "crowd"` (an unconfirmed
  report must not steer a route) and `true` for every other origin.

`routing_evidence` is what a consumer checks before it applies a condition: the
record, effect and binding revisions, the graph generation and resolver
version, the source's rights, freshness and licence, and the directed spans. Its
`direction_mode` is `forward`, `reverse` or `both`, from the bound spans.

### `GET /valhalla/exclusions.json`

Valhalla route-request avoidance for a `bbox` (required) at `at` (default now),
built from the same projection. Only conditions whose routing evidence passes,
whose effect applies to every car (all vehicles, or a vehicle-class list naming
cars with no further condition) and that are in effect at `at` contribute:

- A closure contributes only when its spans cover whole ways in both
  directions. Coordinate avoidance cannot keep a direction or a partial span, so
  those closures are left to `/segments/conditions.json`. Its span geometry is
  sampled into `exclude_locations`, capped at 45 points in total.
- A speed limit that is not advisory contributes one `speed_caps` entry per span
  (`way_id`, `dir`, `start_fraction`, `end_fraction`, `limit_kph`).

The response also carries the projection it was built from as
`routing_evidence`. `Cache-Control` max-age is the time to the earliest
freshness deadline, expiry, validity end or transition among the conditions,
at most 90 s.

## Bindings on the record API

`GET /situations/{id}` returns the situation's own binding beside the record:
`{ status, confidence, directionMode, boundAt }`, or `null` when it has none,
and in `effectBindings` the binding of each effect with a place of its own,
keyed by effect id (empty when no effect has one). Routing reads an effect's
own binding where it has one, so a consumer judging an effect reads it there.
The collections and the TraFF, DATEX II and SSE outputs carry no bindings.

`integrations/road-conditions-openconditions` reads situations from
`GET /situations` and their routing evidence from `/segments/conditions.json`,
over HTTP. It attaches each condition's `routing_evidence` to its situation's
effect by `effect_id`, and fails the routing read when the situation's revision
changed between the two reads or the effect is unknown. The binding status
travels per effect, inside the routing evidence.

## `/feeds/status` metrics

Each feed entry with live situations gains a `binding` object counting the
binding of each situation's own location:

```json
{
  "id": "de-autobahn-a46-roadworks",
  "binding": {
    "activeEvents": 1450,
    "attempted": 1420,
    "attemptedCurrent": 1410,
    "unattempted": 30,
    "obsolete": 10,
    "unattemptedOrObsolete": 40,
    "unknownStatus": 0,
    "exact": 1103,
    "likely": 214,
    "ambiguous": 61,
    "unresolved": 20,
    "noCoverage": 12,
    "notApplicable": 0
  }
}
```

`activeEvents` counts the source's live, unexpired situations. `attempted` is
every one with a stored binding, including any status this reader does not
recognise, so it stays truthful if the resolver ever grows an outcome.
`attemptedCurrent` is the share computed at the situation's current revision on
the active graph; only those are split by status. A binding that is `obsolete`,
or was computed for an older revision or another graph, counts as `obsolete`.
The counts come from one `GROUP BY` cached for 60 s, so polling the status page
is cheap. A failed metrics read is logged and degrades the whole endpoint to no
`binding` keys rather than failing it.

The ratio to watch is `unresolved / attemptedCurrent`. A sudden rise usually
means the feed started publishing on a road class the spine does not import
(see `SEGMENT_HIGHWAY_CLASSES`), not that the resolver regressed. A lasting
`unattemptedOrObsolete` means the binding queue is not draining.

`noCoverage` means a situation lies outside the configured graph regions. Feed
availability is not graph coverage: configure the regions that the selected feeds
actually publish in, then import and activate that graph. No countries are imported
implicitly.

## Configuration

| variable                  | default                                                        | meaning                                                                                            |
| ------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `BIND_ENABLED`            | `true`                                                         | run the binding stage; `false` also disables both rebind passes                                    |
| `BIND_MAX_OFFSET_M`       | `40`                                                           | candidate search radius in metres                                                                  |
| `BIND_CONCURRENCY`        | `8`                                                            | locations resolved in parallel per binder pass                                                     |
| `SEGMENT_HIGHWAY_CLASSES` | `motorway,motorway_link,trunk,trunk_link,primary,primary_link` | OSM `highway` values the spine imports, shared by the osmium filter and the Overpass query         |
| `SEGMENT_REGIONS`         | none (`[]`)                                                    | JSON array of the regions whose spine is imported; a location outside all of them is `no_coverage` |
| `SEGMENT_REBUILD_CRON`    | `0 4 * * 1`                                                    | when the spine rebuild (and with it the forced full rebind) runs; `off` disables it                |

`SEGMENT_REGIONS` is the single region configuration used by import, binding,
graph-readiness checks and local-time speed profiles. It is a JSON array of
`{ id, bbox, tz, pbfUrls?, highwayClasses? }`. IDs must be nonblank, unpadded and
unique. `bbox` must be a nonzero WGS84 rectangle ordered west/south/east/north,
with west < east and south < north; split dateline coverage into two regions.
`tz` must be a supported named timezone (IANA names/aliases or UTC), not a
numeric offset. Invalid configuration is rejected before a rebuild mutates graph
authority. The array is
complete: replacing it replaces the configured coverage, rather than adding to
hidden defaults. Unset, blank or `[]` means no graph coverage is configured;
imports/profiles are skipped and graph activation is refused. Malformed input
fails explicitly.

For example, to import Germany's motorway network, set this in the deployment
environment (or the service's `SEGMENT_REGIONS` setting):

```sh
SEGMENT_REGIONS='[{"id":"de","bbox":[5.866,47.27,15.042,55.059],"tz":"Europe/Berlin","pbfUrls":["https://download.geofabrik.de/europe/germany-latest.osm.pbf"],"highwayClasses":["motorway","motorway_link"]}]'
```

This is an operator example, not a built-in preset. Include additional region
objects in the same array to retain other coverage. `pbfUrls` selects PBF import;
without it, the region uses Overpass at `OVERPASS_URL`. There is no separate source
selector. `SEGMENT_HIGHWAY_CLASSES` supplies the common road-class default;
`highwayClasses` narrows or widens an individual region. Successful import
fingerprints record that exact effective configuration.

**Migration:** the old implicit NL/SE/FI/US-NY list and the newly introduced
`OSM_REGION_PRESET` shortcut were removed. Deployments relying on either must set
`SEGMENT_REGIONS` explicitly before rebuilding. The former `OSM_SOURCE` override
was also removed: add/remove `pbfUrls` on each region instead. No legacy aliases
or additional configuration files are introduced. Source ingestion/display remains
independent of graph configuration; route effects require a ready imported graph.

OpenMapX's downloaded extracts configure its own routing/map datasets. They do not
configure a separately deployed OpenConditions service, which may serve multiple
hosts. OpenMapX's coverage dashboard derives region evidence from those systems;
selecting a dashboard region does not trigger an import. Feed catalogue geography
is descriptive upstream scope, not authority to download a graph automatically.

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
the fastest way to debug a live situation that is not (yet) a corpus case.

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
