import { parseMaxspeedKph } from "./maxspeed.js";
import type { OsmWay } from "./overpass.js";

interface GeojsonFeature {
  type?: string;
  id?: string;
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown>;
}

/**
 * Parse the output of osmium's `export -f geojsonseq --add-unique-id=type_id`
 * (one GeoJSON Feature per line) into {@link OsmWay} records.
 *
 * RFC 8142: each line is prefixed with a `0x1E` record-separator byte, stripped
 * before `JSON.parse`. Only way LineStrings are kept — osmium ids are typed
 * (`w<id>`/`n<id>`/`r<id>`), so a `w` prefix selects ways. Mirrors
 * {@link parseOverpassWays}' contract: never throws — malformed lines, non-way
 * features, and geometry left with fewer than two valid coords are skipped.
 */
export function parseOsmiumGeojsonSeq(input: string | Buffer): OsmWay[] {
  const ways: OsmWay[] = [];
  for (const rawLine of input.toString().split("\n")) {
    // Strip the RFC 8142 record separator (0x1E) if present, then whitespace.
    const line = rawLine.replace(/^\x1e/, "").trim();
    if (line === "") continue;

    let feat: GeojsonFeature;
    try {
      feat = JSON.parse(line) as GeojsonFeature;
    } catch {
      continue;
    }
    if (feat.type !== "Feature") continue;

    // osmium type_id: "w<id>" for ways; skip nodes/relations.
    const id = feat.id;
    if (typeof id !== "string" || id[0] !== "w") continue;
    const wayId = Number(id.slice(1));
    if (!Number.isInteger(wayId)) continue;

    const geom = feat.geometry;
    if (!geom || geom.type !== "LineString" || !Array.isArray(geom.coordinates)) continue;

    const coords: [number, number][] = [];
    for (const pt of geom.coordinates) {
      if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
        coords.push([pt[0] as number, pt[1] as number]);
      }
    }
    if (coords.length < 2) continue;

    const props = feat.properties ?? {};
    const highway = typeof props.highway === "string" ? props.highway : "";
    const onewayTag = typeof props.oneway === "string" ? props.oneway : undefined;
    const oneway = onewayTag === "yes" || onewayTag === "true" || onewayTag === "-1";
    const maxspeedRaw = typeof props.maxspeed === "string" ? props.maxspeed : undefined;
    const maxspeedKph = maxspeedRaw ? parseMaxspeedKph(maxspeedRaw) : null;

    const way: OsmWay = { wayId, coords, highway, oneway };
    if (onewayTag === "-1") way.onewayReversed = true;
    if (typeof props.ref === "string") way.ref = props.ref;
    if (typeof props.name === "string") way.name = props.name;
    if (maxspeedKph != null) way.maxspeedKph = maxspeedKph;
    ways.push(way);
  }
  return ways;
}
