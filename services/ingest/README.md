# OpenConditions Ingest

Fetches open road-condition feeds, normalises them to the canonical model, and
writes them to the shared PostGIS `conditions` schema. Also serves public,
rate-limited emitter feeds (GeoJSON, TraFF, DATEX II, GTFS-RT, JSON-LD, Valhalla
exclusions, SSE).

## Feed sources — layered delivery

The feed set is **operational data**, loaded at boot from three layers and
merged by feed `id`:

1. **Baked-in defaults** — the curated `*.json5` feed files shipped in the image.
2. **Operator-mounted overrides** — a mounted directory read at boot; add or
   override a feed with **no rebuild**.
3. **Optional remote-pull** — pull the feed set from a remote bundle (typically
   the public `road-conditions-atlas`). **Off by default.** The remote source is
   untrusted: every descriptor is schema-validated and every URL is egress-
   guarded, and a vendored snapshot lets the instance survive the remote being
   down.

Precedence when the same `id` appears in more than one layer:
**mounted > remote > baked-in**.

### Settings

All optional. These are non-secret operational settings (not credentials).

| Env var                               | Meaning                                                                                                                | Default              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `OPENCONDITIONS_FEEDS_DIR`            | Directory of operator-mounted `*.json5` feed override/add files; overrides baked-in feeds by `id` with **no rebuild**. | unset (no overrides) |
| `OPENCONDITIONS_FEEDS_REMOTE_URL`     | URL of a remote feed bundle (typically the public `road-conditions-atlas`) to pull descriptors from.                   | `""`                 |
| `OPENCONDITIONS_FEEDS_REMOTE_ENABLED` | `"true"` opts the instance into remote-pull. Anything else = **off**.                                                  | off                  |

When remote-pull is enabled, a snapshot is vendored at
`${OPENCONDITIONS_STATE_DIR:-/data}/feeds/roads.remote-snapshot.json` so the
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

## Record history

`OPENCONDITIONS_HISTORY_DAYS` (default 90) is how long a tombstoned record and
its revisions stay for the history API. Hourly rollups are kept
`OPENCONDITIONS_ROLLUP_HOURLY_DAYS` (35), daily ones
`OPENCONDITIONS_ROLLUP_DAILY_DAYS` (400).

## Credentials

Most feeds are credential-gated: the scheduler skips a feed until all of its
variables are set. See [`docs/road-feed-credentials.md`](../../docs/road-feed-credentials.md)
for how to obtain each key, and `.env.example` for the full list. Credential
metadata is generated — run `pnpm gen:credentials` after changing a feed's auth.

## Speed history finalization

Speed history accepts samples from the current UTC hour and the preceding six
hours. Older samples are rejected with a per-source count in the ingest log;
this does not reject their live observation. The cutoff is aligned to an hour,
so it does not split a histogram's raw input. Replayed samples inside the open
window remain idempotent by sensor and observed timestamp.

Completed open hours are recomputed from retained raw samples. After admission
closes, a final recomputation marks the histogram immutable. Raw retention
(default three days) deletes only whole finalized hours; a delayed aggregation
job therefore retains its inputs until it catches up. A persisted finalization
frontier advances atomically with each batch so routine rollups skip finalized
raw history using the observation-time index. Samples beyond the entire
35-day historical window can be removed without aggregation. Shared admission
locks and exclusive rollup/prune locks keep concurrent arrivals out of a bucket
after finalization. Historical backfill beyond admission is not supported by the
live sample writer; do not widen its window over already-pruned history.
