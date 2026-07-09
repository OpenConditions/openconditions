import type postgres from "postgres";
import { importOsmRoads, loadOsmRegions, overpassSource } from "./osm-import.js";
import { buildSegments } from "./segment-build.js";
import { encodeSegmentOpenlr } from "./segment-openlr.js";
import { matchSensors } from "./sensor-match.js";

type Sql = postgres.Sql;

/**
 * The four rebuild stages as bound, sql-only thunks — the seam that lets a
 * test inject a stage that throws to exercise the catch-and-continue
 * resilience. Production never passes these; the defaults in
 * {@link runSegmentRebuild} bind the real pipeline functions to `deps`.
 */
export interface SegmentRebuildSteps {
  importOsmRoads: (sql: Sql) => Promise<{ imported: number }>;
  buildSegments: (sql: Sql) => Promise<{ built: number }>;
  encodeSegmentOpenlr: (sql: Sql) => Promise<{ encoded: number }>;
  matchSensors: (sql: Sql) => Promise<{ matched: number }>;
}

export interface RunSegmentRebuildDeps {
  fetch: typeof fetch;
  now: () => string;
  /** Test-only overrides for individual stages; absent stages use the real pipeline functions. */
  steps?: Partial<SegmentRebuildSteps>;
}

export interface RunSegmentRebuildResult {
  imported: number;
  built: number;
  encoded: number;
  matched: number;
}

/**
 * Weekly segment-spine rebuild: OSM import into `osm_road` -> directed
 * `road_segment` build (every region, plus the orphan sweep) -> OpenLR
 * encode -> sensor snap into `sensor_segment`, in that order — each stage
 * depends on the previous one's output (segments need fresh `osm_road`,
 * OpenLR needs fresh segments, sensor matching needs both segments and their
 * geometry). Every stage runs in its own try/catch so one stage's failure
 * (Overpass down, an encode/match query error) never blocks the later stages
 * from running against whatever data already exists — it just contributes 0
 * to that stage's count instead of aborting the whole rebuild.
 */
export async function runSegmentRebuild(
  sql: Sql,
  deps: RunSegmentRebuildDeps
): Promise<RunSegmentRebuildResult> {
  const importStep =
    deps.steps?.importOsmRoads ??
    ((s: Sql) =>
      importOsmRoads(s, {
        source: overpassSource(deps.fetch),
        now: deps.now,
        regions: loadOsmRegions(process.env),
      }));
  const buildStep = deps.steps?.buildSegments ?? ((s: Sql) => buildSegments(s, deps.now));
  const encodeStep = deps.steps?.encodeSegmentOpenlr ?? ((s: Sql) => encodeSegmentOpenlr(s));
  const matchStep = deps.steps?.matchSensors ?? ((s: Sql) => matchSensors(s, deps.now));

  let imported = 0;
  try {
    const result = await importStep(sql);
    imported = result.imported;
  } catch (err) {
    console.error("[ingest] segment-rebuild: osm-import failed:", err);
  }

  let built = 0;
  try {
    const result = await buildStep(sql);
    built = result.built;
  } catch (err) {
    console.error("[ingest] segment-rebuild: segment-build failed:", err);
  }

  let encoded = 0;
  try {
    const result = await encodeStep(sql);
    encoded = result.encoded;
  } catch (err) {
    console.error("[ingest] segment-rebuild: openlr-encode failed:", err);
  }

  let matched = 0;
  try {
    const result = await matchStep(sql);
    matched = result.matched;
  } catch (err) {
    console.error("[ingest] segment-rebuild: sensor-match failed:", err);
  }

  return { imported, built, encoded, matched };
}
