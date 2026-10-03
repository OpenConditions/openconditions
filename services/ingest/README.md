# OpenConditions Ingest

Fetches open road-condition feeds, parses road events into model situations and
flow feeds into measurement sites (features) and their `traffic.*` readings
(observations), and writes them to the shared PostGIS
`conditions` schema. Also serves the public,
rate-limited record API (described at `GET /openapi.json`) and the routing
outputs (`/segments/conditions.json`, Valhalla exclusions):

- situations: `/situations` (JSON, `.geojson`, `.jsonld`), `/situations/{id}`,
  `/traff.xml`, `/datex2/situations.xml`, and the `/stream` of server-sent events;
- features: `/features` (JSON, `.geojson`, `.jsonld`; `canonical=1` for the
  canonical view, `expand=components` for components) and `/features/{id}`;
- offers: `/offers` and `/offers/{id}`;
- observations: `/observations/latest` (the reading in effect of every series;
  `canonical=1` for fused readings) and `/observations` (one series' raw readings,
  or its hourly or daily rollups beyond the raw retention);
- `/history/{class}/{id}`, `/taxonomy`, `/schemas/{path}`, `/coverage`.

Every record leaves through the licence egress: share-alike records are
withheld and a crowd reporter's key is stripped. What each route reads is in
[`docs/storage.md`](../../docs/storage.md#read-api).

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

## Raw payloads

Every decoded response a poll receives is archived once, as a zstd blob at
`$OPENCONDITIONS_RAW_DIR/<source_id>/<yyyy-mm-dd>/<sha256>.zst`, and indexed in
`conditions.raw_payload`. A response already archived is only counted again. The
archive is a bounded replay cache for parser bugs, not history: see
[`docs/storage.md`](../../docs/storage.md#raw-payloads) for the tiers and the cap.
A feed whose catalogue `rights.retention` is `false` is never archived; one
without `rights` keeps 48 hours only.

| Env var                                    | Meaning                                                                                | Default      |
| ------------------------------------------ | -------------------------------------------------------------------------------------- | ------------ |
| `OPENCONDITIONS_RAW_DIR`                   | Archive root. The service image mounts the `openconditions-raw` volume at `/data/raw`. | `./data/raw` |
| `OPENCONDITIONS_RAW_MAX_BYTES`             | Cap on the archive's stored bytes; `0` = no cap.                                       | 10 GiB       |
| `OPENCONDITIONS_RAW_HOT_HOURS`             | Every distinct payload is kept this long.                                              | 48           |
| `OPENCONDITIONS_RAW_THIN_DAYS_SITUATION`   | Situation feeds then keep one payload an hour this long.                               | 14           |
| `OPENCONDITIONS_RAW_THIN_DAYS_OBSERVATION` | Flow feeds then keep one payload an hour this long.                                    | 7            |
| `OPENCONDITIONS_RAW_ZSTD_LEVEL`            | zstd compression level.                                                                | 9            |

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
