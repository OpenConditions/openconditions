import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  downloadLargeArtifact,
  type SharedCredentials,
  settingUrl,
  sharedCredentialValue,
} from "@openconditions/ingest-framework";
import { type OsmWay, parseOverpassWays } from "@openconditions/roads";
import type postgres from "postgres";
import { loadHighwayClasses, overpassHighwayRegex } from "./highway-classes.js";
import { pbfToWays } from "./osmium.js";

type Sql = postgres.Sql;

/**
 * One configured region of the OSM highway import: a bounding box and the
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
  /** Optional class restriction; otherwise uses SEGMENT_HIGHWAY_CLASSES. */
  highwayClasses?: string[];
}

/** Exact effective import configuration whose successful rows may attest graph readiness. */
export function osmRegionImportProvenance(
  region: OsmRegion,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  return {
    region_id: region.id,
    bbox: region.bbox,
    timezone: region.tz,
    pbf_urls: [...new Set(region.pbfUrls ?? [])].sort(),
    highway_classes: [...(region.highwayClasses ?? loadHighwayClasses(env))].sort(),
    source: region.pbfUrls && region.pbfUrls.length > 0 ? "pbf" : "overpass",
  };
}

export function osmRegionImportFingerprint(
  region: OsmRegion,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return createHash("sha256")
    .update(JSON.stringify(osmRegionImportProvenance(region, env)))
    .digest("hex");
}

function isOsmRegion(value: unknown): value is OsmRegion {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const baseOk =
    typeof r.id === "string" &&
    r.id.trim().length > 0 &&
    r.id === r.id.trim() &&
    typeof r.tz === "string" &&
    r.tz.trim().length > 0 &&
    r.tz === r.tz.trim() &&
    Array.isArray(r.bbox) &&
    r.bbox.length === 4 &&
    r.bbox.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!baseOk) return false;
  const [west, south, east, north] = r.bbox as number[];
  // This importer uses ordinary rectangular boxes. Dateline coverage needs
  // two explicitly configured regions, not a reversed longitude interval.
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north)
    return false;
  try {
    // PostgreSQL profiles need a named timezone; numeric Intl offset zones
    // are not part of the region contract. IANA aliases and UTC are accepted.
    if (/^[+-]/.test(r.tz as string)) return false;
    new Intl.DateTimeFormat("en", { timeZone: r.tz as string });
  } catch {
    return false;
  }
  // pbfUrls, when present, must be a non-empty array of non-empty strings.
  if (r.pbfUrls !== undefined) {
    if (!Array.isArray(r.pbfUrls) || r.pbfUrls.length === 0) return false;
    if (!r.pbfUrls.every((u) => typeof u === "string" && u.trim() !== "")) return false;
  }
  if (r.highwayClasses !== undefined) {
    if (!Array.isArray(r.highwayClasses) || r.highwayClasses.length === 0) return false;
    if (!r.highwayClasses.every((c) => typeof c === "string" && /^[a-z_]+$/.test(c))) return false;
  }
  return true;
}

/** One authoritative region list for import, binding coverage and local-time profiles.
 * Unset/empty means no configured graph coverage; invalid explicit input fails closed.
 */
export function loadOsmRegions(env: NodeJS.ProcessEnv = process.env): OsmRegion[] {
  const raw = env["SEGMENT_REGIONS"];
  if (raw == null || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SEGMENT_REGIONS is invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("SEGMENT_REGIONS must be a JSON array");
  const regions = parsed.filter(isOsmRegion);
  if (parsed.length > 0 && regions.length === 0)
    throw new Error("SEGMENT_REGIONS contains no valid regions");
  if (regions.length !== parsed.length)
    throw new Error("SEGMENT_REGIONS contains an invalid region");
  if (new Set(regions.map((region) => region.id)).size !== regions.length)
    throw new Error("SEGMENT_REGIONS contains duplicate region IDs");
  return regions;
}

/** Importer contract shared by the Overpass and PBF-extract implementations. */
export interface OsmWaySource {
  fetchRegion(region: OsmRegion): Promise<OsmWay[]>;
}

/** The catalogue setting naming the Overpass instance: its base URL. */
const OVERPASS_SETTING = "@overpass.url";

/**
 * The readers of a group of settings that are no feed, by group: the
 * road-graph import and the speed sensors' maxspeed lookup query the
 * `overpass` group's instance. `pnpm gen:credentials` names them beside the
 * feeds that read the group.
 */
export const SETTING_READERS: Readonly<Record<string, readonly string[]>> = {
  overpass: ["osm-import", "osm-maxspeed"],
};

/**
 * The Overpass interpreter this instance queries: the catalogue's
 * `@overpass.url` (`OVERPASS_URL`, else its default, the public instance)
 * joined to `/api/interpreter` by `settingUrl`, exactly as the OpenStreetMap
 * feeds build it, so the road-graph import, the maxspeed lookup and those feeds
 * always query one Overpass. The value may be the base URL or the full
 * interpreter URL, as OpenMapX's own `OVERPASS_URL` may. A self-hoster points
 * it at their own instance to spare the public server's fair-use budget on
 * heavy region pulls. Throws when the catalogue declares no such setting.
 */
export function overpassInterpreterUrl(
  shared: SharedCredentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = sharedCredentialValue(shared.groups, OVERPASS_SETTING, env);
  if (base === undefined) {
    throw new Error(`the feed catalogue declares no ${OVERPASS_SETTING} setting`);
  }
  return settingUrl(base, "/api/interpreter");
}

// Distinct from osm-maxspeed.ts's per-sensor `around()` lookups, so
// overpass-api.de's operators can tell the two access patterns apart.
const USER_AGENT =
  "OpenConditions-OsmImport/1.0 (+https://github.com/openconditions/openconditions)";

function overpassQuery(region: OsmRegion): string {
  const [w, s, e, n] = region.bbox;
  const highwayFilter = `["highway"~"${overpassHighwayRegex(region.highwayClasses ?? loadHighwayClasses())}"]`;
  return `[out:json][timeout:300];way${highwayFilter}(${s},${w},${n},${e});out geom;`;
}

/**
 * v1 {@link OsmWaySource}: POSTs the bulk `out geom` Overpass query for a
 * region's bbox and parses the response with `parseOverpassWays`. `fetchFn`
 * is the caller's egress-guarded fetch (the scheduler's undici dispatcher
 * wrapped in `guardedFetch`) — this module never opens a bare socket.
 * `Accept-Encoding: gzip` and a distinct User-Agent are required by Overpass
 * etiquette for a query this size (NL alone is ~92k ways / ~87 MB raw).
 * `interpreterUrl` is `overpassInterpreterUrl`'s.
 */
export function overpassSource(fetchFn: typeof fetch, interpreterUrl: string): OsmWaySource {
  return {
    async fetchRegion(region: OsmRegion): Promise<OsmWay[]> {
      const res = await fetchFn(interpreterUrl, {
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

export interface PbfExtractSourceDeps {
  /** Test seam: download an artifact to a temp file. Production uses `downloadLargeArtifact`. */
  download?: (url: string) => Promise<{ path: string; dir: string }>;
  /** Test seam: run the osmium pipeline on a downloaded pbf. Production uses `pbfToWays`. */
  extract?: (
    pbfPath: string,
    bbox: [number, number, number, number],
    workDir: string,
  ) => Promise<OsmWay[]>;
  logger?: { info?: (msg: string) => void };
}

/**
 * {@link OsmWaySource} backed by `.osm.pbf` extracts (§ PBF-extract design).
 * For each unique `region.pbfUrls` entry: download (SSRF-guarded, md5-verified),
 * run osmium filter→clip→export, parse, and concatenate. Border overlap between
 * extracts is deduped by the `way_id` upsert in `importOsmRoads`, so no merge
 * step is needed. Any URL failing fails the whole region (its `fetchRegion`
 * throws) — a knowingly-partial fetch must not reach the swap; the undercoverage
 * guard is the backstop. Each URL's temp dir is removed in a `finally`.
 */
export function pbfExtractSource(deps: PbfExtractSourceDeps = {}): OsmWaySource {
  const download =
    deps.download ??
    (async (url: string) => {
      const dl = await downloadLargeArtifact(url);
      return { path: dl.path, dir: dl.dir };
    });
  const extract = deps.extract ?? ((path, bbox, workDir) => pbfToWays(path, bbox, workDir));

  return {
    async fetchRegion(region: OsmRegion): Promise<OsmWay[]> {
      const urls = region.pbfUrls;
      if (!urls || urls.length === 0) {
        throw new Error(`region ${region.id}: pbfExtractSource requires pbfUrls`);
      }
      const ways: OsmWay[] = [];
      for (const url of [...new Set(urls)]) {
        const dl = await download(url);
        try {
          const extracted =
            deps.extract != null
              ? await extract(dl.path, region.bbox, dl.dir)
              : await pbfToWays(dl.path, region.bbox, dl.dir, {
                  highwayClasses: region.highwayClasses,
                });
          deps.logger?.info?.(
            `[ingest] pbf-extract: ${region.id} ${url} → ${extracted.length} ways`,
          );
          ways.push(...extracted);
        } finally {
          await rm(dl.dir, { recursive: true, force: true });
        }
      }
      return ways;
    },
  };
}

/** Select the import source from the same region configuration used for provenance. */
export function autoOsmSource(overpass: OsmWaySource, pbf: OsmWaySource): OsmWaySource {
  return {
    fetchRegion(region: OsmRegion): Promise<OsmWay[]> {
      return (region.pbfUrls && region.pbfUrls.length > 0 ? pbf : overpass).fetchRegion(region);
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

// Rows per bulk INSERT — one statement per chunk keeps a large import to a few round-trips.
const CHUNK_SIZE = 1000;

// biome-ignore lint/suspicious/noExplicitAny: the driver's JSONB parameter type is intentionally open
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
  import_config_hash: string;
  import_provenance: Record<string, unknown>;
  imported_at: string;
}

function osmRoadRowOf(way: OsmWay, region: OsmRegion, importedAt: string): OsmRoadRow {
  return {
    way_id: way.wayId,
    geometry_json: JSON.stringify({ type: "LineString", coordinates: way.coords }),
    highway: way.highway,
    oneway: way.oneway,
    ref: way.ref ?? null,
    name: way.name ?? null,
    maxspeed_kph: way.maxspeedKph ?? null,
    region: region.id,
    import_config_hash: osmRegionImportFingerprint(region),
    import_provenance: osmRegionImportProvenance(region),
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
  deps: ImportOsmRoadsDeps,
): Promise<{ imported: number; succeededRegions: string[]; failedRegions: string[] }> {
  const swapThreshold = deps.swapThreshold ?? DEFAULT_SWAP_THRESHOLD;
  let imported = 0;
  const succeededRegions: string[] = [];
  const failedRegions: string[] = [];
  for (const region of deps.regions) {
    try {
      const ways = await deps.source.fetchRegion(region);
      const importedAt = deps.now();
      const rows = ways.map((way) => osmRoadRowOf(way, region, importedAt));

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
                `set force to override for a genuine road-network change)`,
            );
          }
        }
        await tx`DELETE FROM conditions.osm_road WHERE region = ${region.id}`;
        for (const batch of chunk(rows, CHUNK_SIZE)) {
          await tx`
            INSERT INTO conditions.osm_road
              (way_id, geom, highway, oneway, ref, name, maxspeed_kph, region,
               import_config_hash, import_provenance, imported_at)
            SELECT
              way_id, ST_SetSRID(ST_GeomFromGeoJSON(geometry_json), 4326),
              highway, oneway, ref, name, maxspeed_kph, region,
              import_config_hash, import_provenance, imported_at
            FROM jsonb_to_recordset(${tx.json(batch as AnyJson)}::jsonb) AS t(
              way_id bigint, geometry_json text, highway text, oneway boolean,
              ref text, name text, maxspeed_kph double precision, region text,
              import_config_hash text, import_provenance jsonb, imported_at timestamptz
            )
            ON CONFLICT (way_id) DO UPDATE SET
              geom = excluded.geom,
              highway = excluded.highway,
              oneway = excluded.oneway,
              ref = excluded.ref,
              name = excluded.name,
              maxspeed_kph = excluded.maxspeed_kph,
              region = excluded.region,
              import_config_hash = excluded.import_config_hash,
              import_provenance = excluded.import_provenance,
              imported_at = excluded.imported_at`;
        }
      });
      imported += rows.length;
      succeededRegions.push(region.id);
    } catch (err) {
      failedRegions.push(region.id);
      console.warn(`[ingest] osm-import: region ${region.id} failed:`, err);
    }
  }
  return { imported, succeededRegions, failedRegions };
}
