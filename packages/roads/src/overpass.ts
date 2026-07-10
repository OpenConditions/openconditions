import { parseMaxspeedKph } from "./maxspeed.js";

/**
 * A single OSM highway way as parsed from an Overpass `out geom` response.
 */
export interface OsmWay {
  wayId: number;
  coords: [number, number][];
  highway: string;
  oneway: boolean;
  /**
   * Set when `tags.oneway === "-1"`: the way carries traffic against its
   * node order, so the segment builder should reverse `coords` before
   * treating the way as a forward-direction segment.
   */
  onewayReversed?: boolean;
  ref?: string;
  name?: string;
  maxspeedKph?: number;
}

interface OverpassGeometryNode {
  lat: number;
  lon: number;
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
  // Overpass emits `null` array entries for nodes it can't resolve (e.g. large
  // `out geom` queries against some instances), so entries are nullable.
  geometry?: (OverpassGeometryNode | null)[];
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

/**
 * Parse an Overpass `out geom` JSON response into `OsmWay` records. Tolerant
 * of malformed input (never throws): unparseable JSON, non-way elements, and
 * ways left with fewer than two VALID geometry nodes all yield an empty result
 * (or are skipped). Null/non-finite geometry entries — which some Overpass
 * instances emit for unresolved nodes on large queries — are dropped rather
 * than crashing the parse.
 */
export function parseOverpassWays(input: string | Buffer): OsmWay[] {
  let parsed: OverpassResponse;
  try {
    parsed = JSON.parse(input.toString()) as OverpassResponse;
  } catch {
    return [];
  }

  const elements = parsed.elements;
  if (!Array.isArray(elements)) return [];

  const ways: OsmWay[] = [];
  for (const el of elements) {
    if (el.type !== "way") continue;
    const geometry = el.geometry;
    if (!Array.isArray(geometry)) continue;
    if (typeof el.id !== "number") continue;

    // Drop null/non-finite nodes (unresolved by Overpass) rather than crashing;
    // a way left with fewer than two valid coords is skipped like any short way.
    const coords: [number, number][] = [];
    for (const node of geometry) {
      if (node && Number.isFinite(node.lon) && Number.isFinite(node.lat)) {
        coords.push([node.lon, node.lat]);
      }
    }
    if (coords.length < 2) continue;

    const tags = el.tags ?? {};
    const onewayTag = tags.oneway;
    const oneway = onewayTag === "yes" || onewayTag === "true" || onewayTag === "-1";
    const maxspeedKph = tags.maxspeed ? parseMaxspeedKph(tags.maxspeed) : null;

    const way: OsmWay = {
      wayId: el.id,
      coords,
      highway: tags.highway ?? "",
      oneway,
    };
    if (onewayTag === "-1") way.onewayReversed = true;
    if (tags.ref) way.ref = tags.ref;
    if (tags.name) way.name = tags.name;
    if (maxspeedKph !== null && maxspeedKph !== undefined) way.maxspeedKph = maxspeedKph;

    ways.push(way);
  }
  return ways;
}
