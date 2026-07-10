import type postgres from "postgres";
import { parseOverpassWays, type OsmWay } from "@openconditions/roads";

type Sql = postgres.Sql;

/**
 * One sensored region of the OSM highway import: an Overpass bbox and the
 * IANA tz used to bucket that region's segment speeds locally.
 */
export interface OsmRegion {
  id: string;
  /** [west, south, east, north] — reordered to Overpass' `(south,west,north,east)` at query time. */
  bbox: [number, number, number, number];
  tz: string;
  /**
   * Optional list of `.osm.pbf` extract URLs (e.g. Geofabrik country/subregion
   * extracts) whose union covers `bbox`. When present, the PBF-extract source is
   * used for this region instead of Overpass (see `pbfExtractSource`); a bbox
   * that straddles a border needs every covering extract listed (border overlap
   * is deduped by the way_id upsert). Absent ⇒ Overpass.
   */
  pbfUrls?: string[];
}

/**
 * v1 sensored regions. Bboxes are deliberately generous (whole-country, not
 * tight to sensor coverage) so a region's own segment spine has margin for
 * future sensor expansion without a re-import. Adding a region beyond these
 * four is a `SEGMENT_REGIONS` config change, not a deploy (see loadOsmRegions).
 */
export const DEFAULT_OSM_REGIONS: OsmRegion[] = [
  { id: "nl", bbox: [3.31, 50.75, 7.09, 53.51], tz: "Europe/Amsterdam" },
  { id: "se", bbox: [11.03, 55.34, 24.18, 69.06], tz: "Europe/Stockholm" },
  { id: "fi", bbox: [20.55, 59.75, 31.59, 70.09], tz: "Europe/Helsinki" },
  { id: "us-ny", bbox: [-79.76, 40.48, -71.75, 45.02], tz: "America/New_York" },
];

function isOsmRegion(value: unknown): value is OsmRegion {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const baseOk =
    typeof r.id === "string" &&
    typeof r.tz === "string" &&
    Array.isArray(r.bbox) &&
    r.bbox.length === 4 &&
    r.bbox.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!baseOk) return false;
  // pbfUrls, when present, must be a non-empty array of non-empty strings.
  if (r.pbfUrls !== undefined) {
    if (!Array.isArray(r.pbfUrls) || r.pbfUrls.length === 0) return false;
    if (!r.pbfUrls.every((u) => typeof u === "string" && u.trim() !== "")) return false;
  }
  return true;
}

/**
 * Loads the OSM import region list from `SEGMENT_REGIONS` (a JSON array of
 * {@link OsmRegion}), falling back to {@link DEFAULT_OSM_REGIONS} when the var
 * is unset, empty (Compose's `${VAR:-}` unset-injection), unparseable, or
 * parses to something with no valid region — adding a region is then a config
 * change an operator can make without a rebuild.
 */
export function loadOsmRegions(env: NodeJS.ProcessEnv = process.env): OsmRegion[] {
  const raw = env["SEGMENT_REGIONS"];
  if (raw == null || raw === "") return DEFAULT_OSM_REGIONS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_OSM_REGIONS;
  }
  if (!Array.isArray(parsed)) return DEFAULT_OSM_REGIONS;
  const regions = parsed.filter(isOsmRegion);
  return regions.length > 0 ? regions : DEFAULT_OSM_REGIONS;
}

/**
 * The import-source seam: `importOsmRoads` never knows where ways come from.
 * v1's only implementation is {@link overpassSource}; a later
 * `pbfExtractSource` (Geofabrik/planet PBF filtered with `osmium tags-filter`,
 * run by a downloader job) is a drop-in behind this same interface, needed
 * both for many-region scale and etiquette once a worldwide instance can no
 * longer fit overpass-api.de's fair-use budget.
 */
export interface OsmWaySource {
  fetchRegion(region: OsmRegion): Promise<OsmWay[]>;
}

// Upgrade path once cadence or region count outgrows overpass-api.de's
// fair-use budget (empirically ~3% of it for a weekly 4-region pull, see the
// plan): swap this fetcher for a `pbfExtractSource` reading Geofabrik/planet
// PBF extracts filtered with `osmium tags-filter` — same `osm_road` sink,
// different fetcher, behind the OsmWaySource interface above.
const DEFAULT_OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/**
 * Resolves the Overpass endpoint from `OVERPASS_URL`, falling back to the
 * public instance when unset or empty (Compose's `${VAR:-}` unset-injection).
 * A self-hoster running their own Overpass (e.g. a planet instance already on
 * the stack) can point large per-region pulls at it to avoid the public
 * server's fair-use budget and client-timeout risk on heavy bboxes.
 */
export function overpassUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["OVERPASS_URL"];
  return raw != null && raw !== "" ? raw : DEFAULT_OVERPASS_URL;
}

const HIGHWAY_FILTER =
  '["highway"~"^(motorway|trunk|motorway_link|trunk_link|primary|primary_link)$"]';

// Distinct from osm-maxspeed.ts's per-sensor `around()` lookups, so
// overpass-api.de's operators can tell the two access patterns apart.
const USER_AGENT =
  "OpenConditions-OsmImport/1.0 (+https://github.com/openconditions/openconditions)";

function overpassQuery(region: OsmRegion): string {
  const [w, s, e, n] = region.bbox;
  return `[out:json][timeout:300];way${HIGHWAY_FILTER}(${s},${w},${n},${e});out geom;`;
}

/**
 * v1 {@link OsmWaySource}: POSTs the bulk `out geom` Overpass query for a
 * region's bbox and parses the response with `parseOverpassWays`. `fetchFn`
 * is the caller's egress-guarded fetch (the scheduler's undici dispatcher
 * wrapped in `guardedFetch`) — this module never opens a bare socket.
 * `Accept-Encoding: gzip` and a distinct User-Agent are required by Overpass
 * etiquette for a query this size (NL alone is ~92k ways / ~87 MB raw).
 */
export function overpassSource(fetchFn: typeof fetch): OsmWaySource {
  return {
    async fetchRegion(region: OsmRegion): Promise<OsmWay[]> {
      const res = await fetchFn(overpassUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Accept-Encoding": "gzip",
          "User-Agent": USER_AGENT,
        },
        body: overpassQuery(region),
      });
      if (!res.ok) {
        throw new Error(`overpass fetch failed for region ${region.id}: HTTP ${res.status}`);
      }
      const text = await res.text();
      return parseOverpassWays(text);
    },
  };
}

export interface ImportOsmRoadsDeps {
  source: OsmWaySource;
  now: () => string;
  regions: OsmRegion[];
  /**
   * Undercoverage guard (the keystone): a region's swap is refused when the new
   * way count is below `swapThreshold × previousCount` (and a previous spine
   * exists), so a silently-truncated import — wrong extract, partial download,
   * Overpass variance — never replaces a good spine. Defaults to 0.9.
   */
  swapThreshold?: number;
  /** Bypass the undercoverage guard for a genuine road-network config change. */
  force?: boolean;
}

const DEFAULT_SWAP_THRESHOLD = 0.9;

// Rows per bulk INSERT — mirrors the chunking in write-postgis.ts/baseline-store.ts.
const CHUNK_SIZE = 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyJson = any;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface OsmRoadRow {
  way_id: number;
  geometry_json: string;
  highway: string;
  oneway: boolean;
  ref: string | null;
  name: string | null;
  maxspeed_kph: number | null;
  region: string;
  imported_at: string;
}

function toRow(way: OsmWay, regionId: string, importedAt: string): OsmRoadRow {
  return {
    way_id: way.wayId,
    geometry_json: JSON.stringify({ type: "LineString", coordinates: way.coords }),
    highway: way.highway,
    oneway: way.oneway,
    ref: way.ref ?? null,
    name: way.name ?? null,
    maxspeed_kph: way.maxspeedKph ?? null,
    region: regionId,
    imported_at: importedAt,
  };
}

/**
 * Bulk-imports each region's OSM highway ways into `conditions.osm_road`: for
 * every region, fetch via `deps.source`, then swap that region's rows in one
 * transaction — `DELETE WHERE region = $id` followed by a chunked
 * `jsonb_to_recordset` INSERT with `ON CONFLICT (way_id) DO UPDATE`
 * (last-import-wins). The upsert (never a plain INSERT) is required because
 * config regions may overlap: a border way deleted out of region A by this
 * same run, then re-inserted under region B later in the loop, would collide
 * on the `way_id` primary key without it — instead it simply changes owner.
 *
 * Regions are processed with a per-region try/catch: one region's Overpass
 * failure (timeout, HTTP error, malformed body) is logged and skipped, never
 * aborting or wiping the regions already committed (mirrors the feed fan-out
 * resilience elsewhere in this service).
 */
export async function importOsmRoads(
  sql: Sql,
  deps: ImportOsmRoadsDeps
): Promise<{ imported: number }> {
  const swapThreshold = deps.swapThreshold ?? DEFAULT_SWAP_THRESHOLD;
  let imported = 0;
  for (const region of deps.regions) {
    try {
      const ways = await deps.source.fetchRegion(region);
      const importedAt = deps.now();
      const rows = ways.map((way) => toRow(way, region.id, importedAt));

      await sql.begin(async (tx) => {
        // Undercoverage guard: throwing here rolls back the transaction BEFORE
        // the DELETE, so the previous spine is preserved intact. The per-region
        // catch below logs it; downstream (build/match) keeps working off the
        // old rows until a healthy import lands.
        if (!deps.force) {
          const [prev] = await tx<{ count: number }[]>`
            SELECT count(*)::int AS count FROM conditions.osm_road WHERE region = ${region.id}`;
          const oldCount = prev?.count ?? 0;
          if (oldCount > 0 && rows.length < swapThreshold * oldCount) {
            throw new Error(
              `region ${region.id}: refusing swap — new ${rows.length} ways < ` +
                `${swapThreshold} × previous ${oldCount} (undercoverage guard; ` +
                `set force to override for a genuine road-network change)`
            );
          }
        }
        await tx`DELETE FROM conditions.osm_road WHERE region = ${region.id}`;
        for (const batch of chunk(rows, CHUNK_SIZE)) {
          await tx`
            INSERT INTO conditions.osm_road
              (way_id, geom, highway, oneway, ref, name, maxspeed_kph, region, imported_at)
            SELECT
              way_id, ST_SetSRID(ST_GeomFromGeoJSON(geometry_json), 4326),
              highway, oneway, ref, name, maxspeed_kph, region, imported_at
            FROM jsonb_to_recordset(${tx.json(batch as AnyJson)}::jsonb) AS t(
              way_id bigint, geometry_json text, highway text, oneway boolean,
              ref text, name text, maxspeed_kph double precision, region text,
              imported_at timestamptz
            )
            ON CONFLICT (way_id) DO UPDATE SET
              geom = excluded.geom,
              highway = excluded.highway,
              oneway = excluded.oneway,
              ref = excluded.ref,
              name = excluded.name,
              maxspeed_kph = excluded.maxspeed_kph,
              region = excluded.region,
              imported_at = excluded.imported_at`;
        }
      });
      imported += rows.length;
    } catch (err) {
      console.warn(`[ingest] osm-import: region ${region.id} failed:`, err);
    }
  }
  return { imported };
}
