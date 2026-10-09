# OpenConditions Ingest

Fetches open road-condition, fuel, parking, charging, camera and hazard feeds, parses road
events into model situations, flow feeds into measurement sites (features) and
their `traffic.*` readings (observations), fuel feeds into stations and their
prices, parking feeds into parking sites, their `parking.*` occupancy readings
and their rates (offers), and charging feeds into charging sites with their
EVSEs and connectors, their `charging.*` status readings and their energy
tariffs (offers), camera feeds into cameras with their views and each
view's `camera.image` reading, and hazard feeds into CAP alerts and natural
hazards (situations) and satellite fire pixels (transient `fire.frp`
readings), and writes them to the shared PostGIS `conditions` schema. Also serves the public,
rate-limited record API (described at `GET /openapi.json`) and the routing
outputs (`/segments/conditions.json`, Valhalla exclusions):

- situations: `/situations` (JSON, `.geojson`, `.jsonld`), `/situations/{id}`,
  `/traff.xml`, `/datex2/situations.xml`, and the `/stream` of server-sent events;
- features: `/features` (JSON, `.geojson`, `.jsonld`; `canonical=1` for the
  canonical view, `expand=components` for components) and `/features/{id}`;
- offers: `/offers` and `/offers/{id}`;
- observations: `/observations/latest` (the reading in effect of every series;
  `canonical=1` for fused readings), `/observations/grid` (one property's readings
  since an instant, aggregated per cell) and `/observations` (one series' raw readings,
  or its hourly or daily rollups beyond the raw retention);
- `/history/{class}/{id}`, `/taxonomy`, `/schemas/{path}`, `/coverage`.

Every record leaves through the request's scope. The **public scope**, the
default, withholds every record of a restricted source (a feed whose rights are
share-alike or forbid redistribution) and every record whose licence is not
public. The **operator scope** withholds nothing; a request reads in it with
`Authorization: Bearer <OPENCONDITIONS_OPERATOR_TOKEN>` and skips the rate
limiter. Any other bearer value is answered
`401 {"error":"invalid operator token"}`, and counts against the caller's rate
limit. While no token is set there is no operator scope: every request, a
bearer one included, reads in the public scope, and the service logs
`operator scope disabled: restricted sources are not served` at startup. Every response varies on `Authorization`; an operator
response is `Cache-Control: private, no-store`. The speed surface
(`/segments.geojson`, `/segments/speed.csv`) withholds, in the public scope, a
speed any restricted source contributed to. The emitters
(`/situations.geojson`, `/situations.jsonld`, `/traff.xml`,
`/datex2/situations.xml`, `/stream`, `/features.geojson`, `/features.jsonld`)
are public feeds and always read in the public scope. A crowd reporter's key is
stripped in every scope. What each route reads is in
[`docs/storage.md`](../../docs/storage.md#read-api).

Feeds with `accessMode: "on_demand"` are not polled. A `/features`,
`/observations/latest` or `/offers` read with a `bbox` and a kind, property or
domain such a feed produces (of the class the route lists: a feed producing
no offers is never fetched for `/offers`) first fetches the feed's stale grid cells inside its
coverage, within its request limits, writes the answers with an expiry and then
answers from storage. The JSON response carries a `coverage` block saying which
on-demand sources were complete for the area (`partial: true` when one was not,
with the reason: too many cells, rate-limited, failed, past the deadline, or
missing credentials). A read without a `bbox` or for a past `at`, and the
GeoJSON and JSON-LD variants, never fetch; `source` limits the sources fetched.
A reader claims a cell in the ledger before fetching it, so readers in other
processes do not fetch it too; a claim a crashed reader left lapses after its
requests' timeout.

| Env var                                | Meaning                                                                                                                      | Default             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `OPENCONDITIONS_OPERATOR_TOKEN`        | Bearer token granting the operator scope; at least 32 characters, or the service fails boot.                                 | unset (public only) |
| `OPENCONDITIONS_ON_DEMAND_DEADLINE_MS` | How long a read waits for its on-demand fetches before it answers from storage; a later fetch still lands for the next read. | 3000                |

## Configuration under OpenMapX

OpenMapX runs this service as a community service. It passes the
`container.environment` of `service.json` to the container verbatim, so that
block holds literal values only (`PORT`, `HOST`, and `OPENCONDITIONS_RAW_DIR`,
`OPENCONDITIONS_ARCHIVE_DIR` and `OPENCONDITIONS_STATE_DIR`, which put what the
service writes on its volume). Everything an operator sets is a field of the
service's `configSchema`. A guard test (`scripts/__tests__/service-manifests.test.ts`)
holds to one or the other every variable named in the source of the service
and of the workspace packages it depends on: read as `env["X"]` or
`process.env.X`, handed to a reader with the environment (`envInt(env, "X")`),
or written as an `OPENCONDITIONS_*` or `*_CRON` name. A name built at run time
escapes it.

- **Secrets** (`x-openmapx-secret`): `DATABASE_URL`, `OPENCONDITIONS_OPERATOR_TOKEN`
  and the feed credentials. The operator sets each once in the admin services
  panel (`openconditions-ingest`, Credentials). OpenMapX mounts it as a file and
  sets `<KEY>_FILE` to its path; the service reads `<KEY>`, else the file
  `<KEY>_FILE` names. A secret has no default. A `DATABASE_URL_FILE` or
  `OPENCONDITIONS_OPERATOR_TOKEN_FILE` that is set but unreadable or empty
  stops the service at boot, naming the file and the cause.
  - `DATABASE_URL` is required: the service refuses to start without it. On the
    shared OpenMapX database it is
    `postgresql://postgres:<POSTGRES_PASSWORD>@postgis:5432/openmapx`, with the
    deployment's own PostgreSQL password.
  - `OPENCONDITIONS_OPERATOR_TOKEN` must equal OpenMapX's own
    `OPENCONDITIONS_OPERATOR_TOKEN` (its `.env`), which `app-api` and the
    data-manager send as their bearer token; the two are set separately.
    Without it, OpenMapX reads in the public scope and serves no Tankerkönig
    (DE), E-Control (AT) or OpenStreetMap station: its fuel layer shows France
    and Spain only, its parking layer no OpenStreetMap, BNLS (FR) or
    Mobidrom Park+Ride (DE) site, its charging layer no OpenStreetMap,
    Open Charge Map or NAP Slovenija site, and its webcam layer no Windy,
    OpenStreetMap or US 511 state camera. Its reads also count against `RATE_LIMIT_MAX` like any
    public client's, which operator scope skips. Set here but different from
    OpenMapX's, every OpenMapX read fails with 401, which stops the road
    conditions overlay, closure avoidance, fuel, parking, charging and camera search and the
    traffic cycles. So set this credential first, then OpenMapX's `.env`, and change
    both together when rotating it. After changing OpenMapX's
    `OPENCONDITIONS_OPERATOR_TOKEN`, run
    `pnpm openmapx services start app-api data-manager` on the OpenMapX host;
    the admin panel never recreates `app-api`.
- **Settings**: every other knob (`OPENCONDITIONS_INSTANCE_ID`, the rate
  limits, `TRUST_PROXY_CIDRS`, `SEGMENT_*`, `BIND_*`, `OPENLR_RESOLVER_URL`,
  the egress and download caps, the raw archive, rollup and archive retention,
  the job schedules, `OVERPASS_URL`, the remote feed bundle). Each carries its default in the
  manifest; an empty default leaves the service's built-in default. The
  operator sets one in the admin services
  panel, or as `SERVICE_OPENCONDITIONS_INGEST_<KEY>` in OpenMapX's `.env`
  (`SERVICE_OPENCONDITIONS_INGEST_RATE_LIMIT_MAX=300`).

A change takes effect once OpenMapX re-renders the service and recreates its
container. Settings kept in OpenMapX's `.env` are applied with
`pnpm openmapx services start openconditions-ingest` (which resets every
setting saved only in the admin form, so keep all of them in one place).
Settings saved in the form are applied with **Save & Apply** on
`openconditions-ingest` in Admin → Services. The field list is written by `pnpm gen:credentials` from
`SERVICE_FIELDS` in `scripts/lib/gen-credentials-lib.ts` and the feed catalogue.
Outside OpenMapX the same variables are plain environment variables; see
`.env.example`.

### Memory

`service.json` limits the container to `OPENCONDITIONS_INGEST_MEMORY` (OpenMapX's
`.env`; default `6g`). The image caps the V8 heap at 75% of that limit
(`NODE_OPTIONS=--max-old-space-size-percentage=75`; Node reads the cgroup
limit), so raising or lowering the limit moves the heap with it: 4608 MB of
heap under `6g`, 3072 MB under `4g`. The remaining quarter is for what lives outside the heap
(fetch buffers, decompression, the raw archive's compression). An operator who
sets `NODE_OPTIONS` replaces this default and sizes the two together.

The national charging registers are the largest polls: IRVE (a 158 MB CSV),
BNetzA (55 MB), NDW's and OCPDB's OCPI dumps. Their drafts stay on the heap
from parse until the write commits, so the scheduler parses and writes one
poll whose payloads reach 16 MiB at a time; smaller polls never wait for it.
Between polls a feed keeps only its latest payloads (gzipped in memory above
1 MiB) and, for a charging feed with a live status role, the status index of
its last full parse: a poll that fetches only live states writes their
readings through that index without parsing the snapshot again. A live state
is written only when it changes (its validity follows the feed's polling,
computed when read), so such a poll writes the one to few thousand states that
changed (IRVE, OCPDB), not every charge point.
With these four feeds alone the heap holds up to about 2.7 GB of live data
and the container peaked at 4.2 GB under a `4g` limit, so `4g` is the floor
for them; the default `6g` leaves room for the rest of the catalogue.

## Feed sources — layered delivery

The feed set is **operational data**, loaded at boot from three layers and
merged by feed `id`:

1. **Baked-in defaults** — the feed catalogue (`feeds/<domain>/<region>.jsonc`,
   see [`feeds/README.md`](../../feeds/README.md)) shipped in the image.
2. **Operator-mounted overrides** — a mounted directory laid out like `feeds/`,
   read at boot; add or override a feed with **no rebuild**.
3. **Optional remote-pull** — pull region files from a remote bundle (such as a
   published `atlas/<domain>.json`). **Off by default.** The remote source is
   untrusted: the bundle is checked like the baked catalogue, every URL is
   egress-guarded, and the last good bundle is kept so the instance survives
   the remote being down.

Precedence when the same `id` appears in more than one layer:
**mounted > remote > baked-in**.

### Settings

All optional. These are non-secret operational settings (not credentials).

| Env var                               | Meaning                                                                                                    | Default              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------- |
| `OPENCONDITIONS_FEEDS_DIR`            | Directory laid out like `feeds/` whose feeds add to or override baked-in ones by `id` with **no rebuild**. | unset (no overrides) |
| `OPENCONDITIONS_FEEDS_REMOTE_URL`     | URL of a remote feed bundle (such as a published `atlas/<domain>.json`) to pull region files from.         | `""`                 |
| `OPENCONDITIONS_FEEDS_REMOTE_ENABLED` | `"true"` opts the instance into remote-pull. Anything else = **off**.                                      | off                  |

When remote-pull is enabled, the last good bundle is kept at
`${OPENCONDITIONS_STATE_DIR:-/data}/feeds/remote-snapshot.json` so the
last-known-good feed set is always available. Mount a volume at the state dir to
persist the snapshot across restarts.

Under OpenMapX the service mounts one volume, `openmapx-openconditions-ingest-data`,
at `/data`, and `service.json` puts the raw archive (`/data/raw`), the nightly
archive (`/data/archive`) and the state dir (`/data`) on it. OpenMapX mounts no
directory of the operator's, so `OPENCONDITIONS_FEEDS_DIR` is not a field there:
a custom catalogue comes through the remote feed bundle.

## Raw payloads

Every decoded response a poll receives is archived once, as a zstd blob at
`$OPENCONDITIONS_RAW_DIR/<source_id>/<yyyy-mm-dd>/<sha256>.zst`, and indexed in
`conditions.raw_payload`. A response already archived is only counted again. The
archive is a bounded replay cache for parser bugs, not history: see
[`docs/storage.md`](../../docs/storage.md#raw-payloads) for the tiers and the cap.
A feed whose catalogue `rights.retention` is `false` is never archived; one
without `rights` keeps 48 hours only.

| Env var                                    | Meaning                                                                       | Default      |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ------------ |
| `OPENCONDITIONS_RAW_DIR`                   | Archive root; `service.json` sets it to `/data/raw`, on the service's volume. | `./data/raw` |
| `OPENCONDITIONS_RAW_MAX_BYTES`             | Cap on the archive's stored bytes; `0` = no cap.                              | 10 GiB       |
| `OPENCONDITIONS_RAW_HOT_HOURS`             | Every distinct payload is kept this long.                                     | 48           |
| `OPENCONDITIONS_RAW_THIN_DAYS_SITUATION`   | Situation feeds then keep one payload an hour this long.                      | 14           |
| `OPENCONDITIONS_RAW_THIN_DAYS_OBSERVATION` | Flow feeds then keep one payload an hour this long.                           | 7            |
| `OPENCONDITIONS_RAW_ZSTD_LEVEL`            | zstd compression level.                                                       | 9            |

`pnpm --filter @openconditions/ingest raw <command>` runs the archive's
commands against `DATABASE_URL`:

- `raw pin <hash> [--fixture <name>] [--source <id>]` keeps a payload whatever
  eviction would do (a golden fixture, a disputed record); `raw unpin <hash>`
  hands it back.
- `raw gc [--dry-run]` runs eviction now, or only reports what it would evict.
- `raw replay <source> --from <time> [--to <time>]` re-parses each archived
  published poll of an event feed with the current parser and lists, per poll,
  the situations that read the same, changed, new or gone against what that poll
  stored. It writes nothing; see
  [`docs/storage.md`](../../docs/storage.md#replay).

## Record history

`OPENCONDITIONS_HISTORY_DAYS` (default 90) is how long a tombstoned record and
its revisions stay for the history API. Hourly rollups are kept
`OPENCONDITIONS_ROLLUP_HOURLY_DAYS` (35), daily ones
`OPENCONDITIONS_ROLLUP_DAILY_DAYS` (400). A poll holding more than
`OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL` readings (1 000 000) or 100 000
records of one class is refused whole.

## Credentials

Most feeds are credential-gated: the scheduler skips a feed until all of its
variables are set. See [`docs/feed-credentials.md`](../../docs/feed-credentials.md)
for how to obtain each key, and `.env.example` for the full list. Credential
metadata is generated — run `pnpm gen:credentials` after changing a feed's
credentials or auth.

`OVERPASS_URL` is a setting, not a credential: the **base URL** of the Overpass
instance (`http://overpass:80`, default `https://overpass-api.de`) or its full
interpreter URL (`http://overpass:80/api/interpreter`), the two forms OpenMapX's
own `OVERPASS_URL` accepts; a trailing slash is ignored, and a base URL carries
no query or fragment. The OpenStreetMap sources, the road-graph import and the
maxspeed fallback all query `<base>/api/interpreter`. In an OpenMapX deployment
it is the service's config, a non-secret field of `service.json`'s
`configSchema` with that default: set it in the admin services panel, or as
`SERVICE_OPENCONDITIONS_INGEST_OVERPASS_URL` in OpenMapX's `.env`. A private
Overpass host also needs `OPENCONDITIONS_EGRESS_ALLOWED_HOSTS`, since the
egress guard refuses private addresses otherwise.

## Speed history

A flow poll writes its sites, readings and derived congestion through the
record writer in one transaction with the poll's status. Every site-level
reading goes to the partitioned observation history (`traffic.speed` keeps
three days of raw readings, volumes and occupancy two); readings about a lane
or vehicle class only update the latest row. The record jobs roll finished
hours up into `observation_rollup_hourly` (sparse 2 km/h speed histograms,
35 days), six hours after an hour ends. A reading that arrives after its hour
was rolled up stays in the raw history but never reaches the rollup; the poll
counts it (`pastRollup`, logged per source). A day of raw history is dropped
only once the rollup has passed it.

The nightly baseline job (native Fintraffic constants, derived p85 free flow,
OSM maxspeed fallback) and the weekly segment profiles read the hourly rollup;
both key measurement sites by the subject key of their speed series
(`feature:<featureId>`). Free-flow baselines ignore readings below 2 km/h
(bin 0), so a standing queue does not drag a site's free flow down.
