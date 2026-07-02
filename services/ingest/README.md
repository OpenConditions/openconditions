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

## Credentials

Most feeds are credential-gated: the scheduler skips a feed until all of its
variables are set. See [`docs/road-feed-credentials.md`](../../docs/road-feed-credentials.md)
for how to obtain each key, and `.env.example` for the full list. Credential
metadata is generated — run `pnpm gen:credentials` after changing a feed's auth.
