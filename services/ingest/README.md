# OpenConditions Ingest

Fetches open road-condition, fuel, parking, charging, camera, hazard, weather, vehicle and border feeds, parses road
events into model situations, flow feeds into measurement sites (features) and
their `traffic.*` readings (observations), fuel feeds into stations and their
prices, parking feeds into parking sites, their `parking.*` occupancy readings
and their rates (offers), and charging feeds into charging sites with their
EVSEs and connectors, their `charging.*` status readings and their energy
tariffs (offers), camera feeds into cameras with their views and each
view's `camera.image` reading, and hazard feeds into CAP alerts and natural
hazards (situations) and satellite fire pixels (transient `fire.frp`
readings), weather feeds into weather stations with a channel per
road-surface sensor and their `weather.*` and `road.*` readings, maintenance
tracking into anonymous `vehicle.position` readings, and border feeds into
crossings with a lane group per queue and its `border.wait` reading, and
writes them to the shared PostGIS `conditions` schema. Also serves the public,
rate-limited record API (described at `GET /openapi.json`) and the routing
outputs (`/segments/conditions.json`, Valhalla exclusions):

- situations: `/situations` (JSON, `.geojson`, `.jsonld`), `/situations/{id}`,
  `/traff.xml`, `/datex2/situations.xml`, and the `/stream` of server-sent events;
- features: `/features` (JSON, `.geojson`, `.jsonld`; `canonical=1` for the
  canonical view, `expand=components` for components) and `/features/{id}`;
- offers: `/offers` and `/offers/{id}`;
- observations: `/observations/latest` (the reading in effect of every series;
  `canonical=1` for fused readings), `/observations/grid` (one property's readings
  since an instant, aggregated per cell; both take `minConfidence` to leave out
  readings of lower stated confidence, such as low-confidence fire detections) and
  `/observations` (one series' raw readings, or its hourly or daily rollups beyond
  the raw retention);
- `/history/{class}/{id}`, `/taxonomy`, `/schemas/{path}`, `/coverage`.

Every record leaves through the request's scope. The **public scope**, the
default, withholds every record of a restricted source (a feed whose rights are
share-alike, or whose redistribution is not established: denied, unstated, or
granted by a licence claim no one has checked against the publisher's
statement; see `feeds/README.md`) and every record whose licence is not
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
block holds literal values only (`PORT`, `HOST`, `OPENCONDITIONS_INGEST_ROLE`, and `OPENCONDITIONS_RAW_DIR`,
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
- **Settings**: every other knob (`OPENCONDITIONS_INSTANCE_ID`, the crowd
  credit `/sources` states, `OPENCONDITIONS_CROWD_LICENSE` and
  `OPENCONDITIONS_CROWD_SOURCE_URI`, which must equal the contributions
  API's, the rate
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
`.env`; default `8g`). The image caps the V8 heap at 55% of that limit
(`NODE_OPTIONS=--max-old-space-size-percentage=55`; Node reads the cgroup
limit), so raising or lowering the limit moves the heap with it: 4505 MB of
heap under `8g`, 3379 MB under `6g`. The parse child below takes up to 30%,
and the remaining 15% is for what lives outside the heaps (fetch buffers,
decompression, the raw archive's compression), so both heaps full at once
still fit the limit. An operator who sets `NODE_OPTIONS` or
`OPENCONDITIONS_PARSE_HEAP_MB` replaces these defaults and sizes the three
together. A segment region (`SEGMENT_REGIONS`) adds its weekly rebuild to the
service's heap: about 1.7 GB for Germany.

The national charging registers are the largest polls: IRVE (a 158 MB CSV),
BNetzA (55 MB), NDW's and OCPDB's OCPI dumps. Their drafts stay on the heap
from parse until the write commits, so the scheduler parses and writes one
poll whose payloads reach 16 MiB at a time; smaller polls never wait for it.
Such a payload is parsed in a child process, which sends the drafts back in
slices: its seconds of synchronous parsing no longer stall the other polls
or the API, and a parse that outgrows the child's heap fails that poll
alone. The child's heap is capped at 30% of the container's memory
(`--max-old-space-size-percentage=30`; NDW's register needs about 1.8 GB),
or at `OPENCONDITIONS_PARSE_HEAP_MB`; it inherits none of the service's
`NODE_OPTIONS`. It stops a minute after its last parse, so the heap a register
took is not held between polls. A parse that reads reference data (a site
table) stays inline.
Between polls a feed keeps only its latest payloads (gzipped in memory above
1 MiB) and, for a charging feed with a live status role, the status index of
its last full parse: a poll that fetches only live states writes their
readings through that index without parsing the snapshot again. A live state
is written only when it changes (its validity follows the feed's polling,
computed when read), so such a poll writes the one to few thousand states that
changed (IRVE, OCPDB), not every charge point.
With these four feeds alone the heap holds up to about 2.7 GB of live data
and the container peaked at 4.2 GB under a `4g` limit. `6g` is the floor for
them: below it the child's 30% no longer holds NDW's parse. The default `8g`
leaves room for the rest of the catalogue and a segment region.

### Database connections

The service keeps three connection pools, each with its own timeouts, set as
connection startup parameters rather than on the database or role (which
OpenMapX shares):

| Pool (`application_name`)           | Serves                                                                                                           | Statement | Lock wait | Idle in transaction |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------- | --------- | ------------------- |
| `openconditions-ingest-writer`      | Feed polls, the binding drain, the segment-speed and fusion refreshes                                            | 5 min     | 1 min     | 10 min              |
| `openconditions-ingest-api`         | HTTP reads and on-demand cell writes                                                                             | 20 s      | 5 s       | 1 min               |
| `openconditions-ingest-maintenance` | Partitions, rollups, the sweep, raw eviction, poll-history pruning, baselines, the archive and the segment spine | 1 h       | 5 s       | 15 min              |

They hold at most 5, 5 and 2 connections, and each closes a connection idle
for 30 s. One more connection, `openconditions-ingest-claims`, stays open for
the life of the process and holds its claims (see
[A second ingest process](#a-second-ingest-process)); migrations open their own
while they run. A process with the `feeds` role never opens the API pool and
uses the maintenance pool for its raw eviction only, so it holds at most 8.

A poll that runs or waits past them fails with an error starting
`db_timeout:`, keeps the last publication and is tried again on its next tick.
A maintenance job that meets a held lock leaves the work to its next run: the
sweep skips the busy source (`busy` in its log line), and the hourly partition
run tries again an hour later, as partitions exist 16 days ahead. At boot the
partitions are tried a few times before the service gives up. Migrations run
without a statement or lock timeout.

## A second ingest process

All feeds share one Node process, and a feed's parse and its records'
validation run on its main thread. A feed that takes longer than its cadence
(NDW's `nl-ndw-flow`, about 174 000 readings every 60 s) skips its own ticks
and delays every other feed's poll behind it. Such feeds can run in a second
process of the same image, with its own thread, heap and parse child:

| Env var                               | Meaning                                                                                                 | Default            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------ |
| `OPENCONDITIONS_INGEST_ROLE`          | `primary`, or `feeds` for a process that only polls the feeds `OPENCONDITIONS_INGEST_FEEDS` names.      | `primary`          |
| `OPENCONDITIONS_INGEST_FEEDS`         | Comma-separated feed ids this process polls; `*` matches any run of characters (`nl-ndw-*`).            | unset (every feed) |
| `OPENCONDITIONS_INGEST_FEEDS_EXCLUDE` | Comma-separated feed ids (or patterns) this process leaves to another process. Applied after the above. | unset (none)       |

The **primary** serves the HTTP API (on-demand feeds included) and runs what
one process of a deployment must run: the catalogue sync, partitions, rollups,
the record sweep, the fusion and federation refreshes, the binding queue's
drain, the segment, baseline and archive jobs, poll-history pruning and the
boot rebind. A **feeds** process runs none of it: it migrates the database
(under the migrations' advisory lock, so two processes never migrate at
once), polls its feeds and answers `GET /status` for its health check. Each
process closes, at boot, the poll attempts its own stopped polls left running,
and archives its feeds' raw payloads under its own `OPENCONDITIONS_RAW_DIR`.
Each evicts the blobs in its own directory, whichever feed they are of, by the
same rules as one archive (a source's payloads are weighed together wherever
they lie); the raw cap (`OPENCONDITIONS_RAW_MAX_BYTES`) applies to each
directory separately. A feed moved from one process to the other has the
payloads it already archived evicted on their normal schedule by the process
that holds them. A feeds process's polls leave their road-graph binding work
queued for the primary's next drain.

To split, give both processes the same list, the primary as
`OPENCONDITIONS_INGEST_FEEDS_EXCLUDE` and the feeds process as
`OPENCONDITIONS_INGEST_FEEDS`; every polled feed then falls to exactly one of
them. Each process claims, at boot, every feed it polls (and the primary its
role) with a PostgreSQL session advisory lock held for its life, and stops
with an error naming a feed another live process already polls, or saying a
primary already runs. A name in `OPENCONDITIONS_INGEST_FEEDS` that matches no
feed of the catalogue stops boot, as does a feeds process left with no feed to
poll; one in `OPENCONDITIONS_INGEST_FEEDS_EXCLUDE` only warns, so the primary
keeps serving when a release drops a feed it was told to leave.

The feeds process needs the settings its polls read, set to the primary's
values: `DATABASE_URL`, `OPENCONDITIONS_INSTANCE_ID` (its records' namespace),
the credentials of its feeds, `OPENLR_RESOLVER_URL`, the egress, fetch and raw
archive settings. `GET /feeds/status` on the primary lists every feed with its
durable status, whichever process polls it. `raw replay` reads the blobs in
its process's directory, and `raw gc` evicts those, so run them in the process
that archived the payloads.

Under OpenMapX the second process is the optional service
`openconditions-ingest-heavy` (`services/ingest-heavy/service.json`): the same
image with `OPENCONDITIONS_INGEST_ROLE=feeds`, its own volume, a memory limit of
`OPENCONDITIONS_INGEST_HEAVY_MEMORY` (default `6g`, the floor for NDW's
charging register) and the ingest service's fields. It is not part of the
extension's default install: OpenMapX enables every service an extension
lists, and connects a community service to its database only when its
`postgis` service names it in `communityNetworkAccess`, which names
`openconditions-ingest` and `openconditions-contributions-api` only. Once
OpenMapX names `openconditions-ingest-heavy` there, enable it, with the list
`nl-ndw-flow,nl-ndw-charging`:

1. On `openconditions-ingest-heavy`, set `DATABASE_URL`, the instance id and
   any credential its feeds need to the primary's values, and
   `OPENCONDITIONS_INGEST_FEEDS` to the list
   (`SERVICE_OPENCONDITIONS_INGEST_HEAVY_OPENCONDITIONS_INGEST_FEEDS` in
   OpenMapX's `.env`).
2. On `openconditions-ingest`, set `OPENCONDITIONS_INGEST_FEEDS_EXCLUDE` to the
   same list.
3. `pnpm openmapx services enable openconditions-ingest-heavy`, then
   `pnpm openmapx services start openconditions-ingest openconditions-ingest-heavy`.

Started before the primary has been recreated, the feeds process stops at
boot (the primary still polls its feeds) and its restart policy retries once
the primary has. To undo:

1. Disable `openconditions-ingest-heavy`, clear the primary's
   `OPENCONDITIONS_INGEST_FEEDS_EXCLUDE` and start the primary again.
2. Remove the feeds process's volume (`openmapx-openconditions-ingest-heavy-data`),
   which deletes the payloads it archived; nothing else would evict them.
3. In the primary's container, run `raw forget-missing` to count the index rows
   whose blob went with the volume, then `raw forget-missing --apply` to mark
   them evicted. Name feeds (`raw forget-missing nl-ndw-flow --apply`) to limit
   it to them. It refuses to run in a feeds process, and leaves any feed a live
   feeds process still polls, as that one's blobs lie in its own archive.

Outside OpenMapX, run a second container of the image beside the first, with
its own volume:

```yaml
ingest-heavy:
  image: ghcr.io/openconditions/ingest:latest
  restart: unless-stopped
  mem_limit: 6g
  env_file: .env # DATABASE_URL, OPENCONDITIONS_INSTANCE_ID, the credentials
  environment:
    OPENCONDITIONS_INGEST_ROLE: feeds
    OPENCONDITIONS_INGEST_FEEDS: nl-ndw-flow,nl-ndw-charging
    OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: ""
    OPENCONDITIONS_RAW_DIR: /data/raw
    OPENCONDITIONS_STATE_DIR: /data
  volumes:
    - ingest-heavy-data:/data
  depends_on:
    ingest:
      condition: service_healthy
```

and give the primary `OPENCONDITIONS_INGEST_FEEDS_EXCLUDE: nl-ndw-flow,nl-ndw-charging`.

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
- `raw forget-missing [<source>...] [--apply]`, in the primary, counts the held
  payloads whose blob is not in its archive (those of a retired
  [second ingest process](#a-second-ingest-process)), and with `--apply` marks
  them evicted.
- `raw replay <source> --from <time> [--to <time>]` re-parses each archived
  published poll of an event feed with the current parser and lists, per poll,
  the situations that read the same, changed, new or gone against what that poll
  stored. It writes nothing; see
  [`docs/storage.md`](../../docs/storage.md#replay).

## Offline feed inspection

`pnpm --silent --filter @openconditions/ingest inspect-feed <source> --at <time> --payload <file>`
connects a captured situation payload to its parser drafts, canonical validation,
effect states and actual GeoJSON/TraFF/DATEX output. It makes no network requests
and requires no database or acquisition credentials. See the
[feed-inspection guide](../../docs/feed-inspection.md) for reproducible samples,
rights/omission diagnostics and the path into raw replay, histories and binding
readiness. Canonical previews are synthetic; this does not simulate ingestion.

## Record history

`OPENCONDITIONS_HISTORY_DAYS` (default 90) is how long a tombstoned record and
its revisions stay for the history API. Hourly rollups are kept
`OPENCONDITIONS_ROLLUP_HOURLY_DAYS` (35), daily ones
`OPENCONDITIONS_ROLLUP_DAILY_DAYS` (400). A poll holding more than
`OPENCONDITIONS_MAX_OBSERVATIONS_PER_POLL` readings (1 000 000) or 100 000
records of one class is refused whole. A process remembers what each polled
series holds, so a reading a poll restates unchanged is checked against its
row instead of read back; `OPENCONDITIONS_LATEST_CACHE_MB` bounds that memory
(default 8% of the heap limit, `0` off). A source is cached whole or not at
all: one that does not fit the remaining budget is logged once and read back
every poll.

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

### OAuth2 logins

A feed with `oauth2-authorization-code` auth (EUMETSAT's Sentinel-3 fires) reads
an account the operator logs in once, not a key: its grant lives in
`conditions.oauth_grant`, which the service renews itself (see
[`feeds/README.md`](../../feeds/README.md#credentials)). The commands run
against `DATABASE_URL` in the image as `node dist/feed-auth.js <command>`, in
a checkout as `pnpm --filter @openconditions/ingest feed-auth <command>`:

- `login <grant>` prints the provider's login URL and asks for the
  authorization code the page shows after the login; paste it at once, as it
  lapses within minutes. Run it with a terminal:
  `docker compose exec -it ingest node dist/feed-auth.js login eumetsat`
  (the compose service is `openconditions-ingest` under OpenMapX).
- `import <grant>` reads a refresh token obtained elsewhere from stdin, never
  from the command line or the environment, spends it on one refresh to prove
  it and stores the refresh token that refresh returned:
  `docker compose exec -T ingest node dist/feed-auth.js import eumetsat < token-file`.
- `status [<grant>...]` shows whether a login is stored, until when the access
  token is valid, when the refresh token was issued and until when the
  provider honours it, and the last error; it never prints a token.

A feed whose grant has no login, or whose refresh token the provider refused
(30 days unused, or revoked), fails each poll with the `login` command in its
status error and sends the provider nothing until the operator logs in again.
A token request that fails otherwise (the provider down) is retried at the
next poll.

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

## Public stream reconnects

The public `/stream` starts a replacement view on every connection. Clear that
subscription's previous IDs on each successful `open`, including reconnects;
`Last-Event-ID` does not resume missed events. The stream has no initial snapshot
completion marker and can truncate at 20,000 situations. See the
[reconnect investigation and consumer contract](../../docs/public-stream-reconnect.md)
for lifecycle tests, measured costs and the decision to defer durable public replay.
