import type postgres from "postgres";
import {
  autoOsmSource,
  importOsmRoads,
  loadOsmRegions,
  overpassSource,
  pbfExtractSource,
} from "./osm-import.js";
import { rebindAll } from "./rebind.js";
import { buildSegments } from "./segment-build.js";
import { encodeSegmentOpenlr } from "./segment-openlr.js";
import { matchSensors } from "./sensor-match.js";
import { activateRoadGraph, beginRoadGraphRebuild } from "./graph-state.js";

type Sql = postgres.Sql;

/**
 * The rebuild stages as bound, sql-only thunks — the seam that lets a test
 * inject a stage that throws to exercise the catch-and-continue resilience.
 * Production never passes these; the defaults in {@link runSegmentRebuild}
 * bind the real pipeline functions to `deps`.
 */
export interface SegmentRebuildSteps {
  importOsmRoads: (sql: Sql) => Promise<{
    imported: number;
    succeededRegions?: string[];
    failedRegions?: string[];
  }>;
  buildSegments: (sql: Sql) => Promise<{ built: number }>;
  encodeSegmentOpenlr: (sql: Sql) => Promise<{ encoded: number }>;
  matchSensors: (sql: Sql) => Promise<{ matched: number }>;
  rebindAll: (sql: Sql) => Promise<{ rebound: number; prunedSegments: number }>;
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
  rebound: number;
}

/**
 * Weekly segment-spine rebuild: OSM import into `osm_road` -> directed
 * `road_segment` build (every region, plus the orphan sweep) -> OpenLR
 * encode -> sensor snap into `sensor_segment` -> event rebind, in that order —
 * each stage depends on the previous one's output (segments need fresh
 * `osm_road`, OpenLR needs fresh segments, sensor matching needs both segments
 * and their geometry, and the rebind needs the finished spine because segment
 * ids move when the underlying ways change). Every stage runs in its own
 * try/catch so one stage's failure
 * (Overpass down, an encode/match query error) never blocks the later stages
 * from running against whatever data already exists — it just contributes 0
 * to that stage's count instead of aborting the whole rebuild.
 */
export async function runSegmentRebuild(
  sql: Sql,
  deps: RunSegmentRebuildDeps
): Promise<RunSegmentRebuildResult> {
  // Reject malformed configuration before invalidating a previously usable graph.
  const regions = loadOsmRegions(process.env);
  try {
    await beginRoadGraphRebuild(sql);
  } catch (err) {
    console.error("[ingest] segment-rebuild: could not invalidate active graph:", err);
    return { imported: 0, built: 0, encoded: 0, matched: 0, rebound: 0 };
  }
  if (regions.length === 0) {
    console.warn(
      "[ingest] segment-rebuild: SEGMENT_REGIONS is empty; graph coverage is not configured"
    );
    return { imported: 0, built: 0, encoded: 0, matched: 0, rebound: 0 };
  }
  const importStep =
    deps.steps?.importOsmRoads ??
    ((s: Sql) =>
      importOsmRoads(s, {
        // Per-region source selection: regions with `pbfUrls` use the PBF-extract
        // source (deterministic, complete), the rest use Overpass. No fallback.
        source: autoOsmSource(
          overpassSource(deps.fetch),
          pbfExtractSource({ logger: { info: (m) => console.info(m) } })
        ),
        now: deps.now,
        regions,
      }));
  const buildStep = deps.steps?.buildSegments ?? ((s: Sql) => buildSegments(s, deps.now));
  const encodeStep = deps.steps?.encodeSegmentOpenlr ?? ((s: Sql) => encodeSegmentOpenlr(s));
  const matchStep = deps.steps?.matchSensors ?? ((s: Sql) => matchSensors(s, deps.now));
  const rebindStep = deps.steps?.rebindAll ?? ((s: Sql) => rebindAll(s, { now: deps.now }));

  let imported = 0;
  let importComplete = false;
  try {
    const result = await importStep(sql);
    imported = result.imported;
    importComplete = !result.failedRegions || result.failedRegions.length === 0;
  } catch (err) {
    console.error("[ingest] segment-rebuild: osm-import failed:", err);
  }

  let built = 0;
  let buildComplete = false;
  let graphReady = false;
  try {
    if (!importComplete)
      throw new Error("road graph preflight: one or more configured imports failed");
    const result = await buildStep(sql);
    built = result.built;
    buildComplete = true;
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
    if (!buildComplete) throw new Error("road graph preflight: segment build was not complete");
    await activateRoadGraph(sql, { now: deps.now });
    graphReady = true;
  } catch (err) {
    console.error("[ingest] segment-rebuild: sensor-match failed:", err);
  }

  let rebound = 0;
  try {
    if (!graphReady) throw new Error("active graph generation was not recorded");
    const result = await rebindStep(sql);
    rebound = result.rebound;
  } catch (err) {
    console.error("[ingest] segment-rebuild: rebind failed:", err);
  }

  return { imported, built, encoded, matched, rebound };
}
