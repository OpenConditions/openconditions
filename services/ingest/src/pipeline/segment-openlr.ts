import type postgres from "postgres";
import { encodeOpenlrLine } from "@openconditions/openlr";

type Sql = postgres.Sql;

// Rows per bulk UPDATE — mirrors the chunking in osm-import.ts/write-postgis.ts.
const CHUNK_SIZE = 1000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Functional Road Class from an OSM `highway` value, per the OpenLR spec's
 * usual FRC ladder (0 = highest class).
 */
function deriveFrc(highway: string): number {
  switch (highway) {
    case "motorway":
      return 0;
    case "trunk":
      return 1;
    case "primary":
      return 2;
    case "secondary":
      return 3;
    case "tertiary":
      return 4;
    default:
      return 5;
  }
}

/**
 * Form of Way per the OpenLR enum. `road_segment`/`osm_road` don't track OSM's
 * `junction` tag today, so the ROUNDABOUT (4) branch never fires yet — it's
 * kept here so a future `junction` column only needs to thread the value in.
 */
function deriveFow(highway: string, oneway: boolean, junction?: string | null): number {
  if (junction === "roundabout") return 4;
  if (highway === "motorway" || highway === "motorway_link") return 1;
  if (oneway) return 2;
  return 3;
}

interface StaleSegmentRow {
  segment_id: string;
  highway: string;
  oneway: boolean;
  coords: [number, number][];
}

/**
 * Encodes an OpenLR line descriptor for every `road_segment` row lacking one
 * (`openlr IS NULL`). `segment-build.ts` rebuilds a region with a scoped
 * DELETE + INSERT that never re-populates `openlr`, so after a weekly rebuild
 * every segment in that region has a null `openlr` and gets re-encoded here —
 * this re-encodes the whole rebuilt region, not just the rows whose geometry
 * actually changed. That's acceptable for v1; a true only-changed
 * optimization (diff geometry, or a version column) is deferred. FRC/FOW are
 * derived from `highway` (own column) and `oneway` (joined from `osm_road` via
 * `way_id`, since `road_segment` doesn't carry it directly), then
 * {@link encodeOpenlrLine} does the actual LRP selection + binary packing.
 *
 * A single degenerate-geometry row (e.g. a collapsed segment with fewer than
 * two coordinates) makes {@link encodeOpenlrLine} throw; that row is logged
 * and skipped so one bad segment never aborts the whole batch. Updates are
 * batched via the same `jsonb_to_recordset` idiom used elsewhere in this
 * pipeline.
 */
export async function encodeSegmentOpenlr(sql: Sql): Promise<{ encoded: number }> {
  const rows = await sql<StaleSegmentRow[]>`
    SELECT s.segment_id AS segment_id,
           s.highway AS highway,
           r.oneway AS oneway,
           (ST_AsGeoJSON(s.geom)::json ->> 'coordinates')::jsonb AS coords
    FROM conditions.road_segment s
    JOIN conditions.osm_road r ON r.way_id = s.way_id
    WHERE s.openlr IS NULL`;

  if (rows.length === 0) {
    return { encoded: 0 };
  }

  const updates: { segment_id: string; openlr: string }[] = [];
  let skipped = 0;
  for (const row of rows) {
    try {
      const frc = deriveFrc(row.highway);
      const fow = deriveFow(row.highway, row.oneway);
      const openlr = encodeOpenlrLine({ coords: row.coords, frc, fow });
      updates.push({ segment_id: row.segment_id, openlr });
    } catch (err) {
      skipped++;
      console.warn(`[ingest] segment-openlr: encode failed for ${row.segment_id}, skipping:`, err);
    }
  }

  for (const batch of chunk(updates, CHUNK_SIZE)) {
    await sql`
      UPDATE conditions.road_segment AS s
      SET openlr = t.openlr
      FROM jsonb_to_recordset(${sql.json(batch)}::jsonb) AS t(segment_id text, openlr text)
      WHERE s.segment_id = t.segment_id`;
  }

  if (skipped > 0) {
    console.warn(
      `[ingest] segment-openlr: skipped ${skipped} segment(s) with unencodable geometry`
    );
  }

  return { encoded: updates.length };
}
