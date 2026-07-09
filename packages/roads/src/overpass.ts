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
  geometry?: OverpassGeometryNode[];
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

/**
 * Parse an Overpass `out geom` JSON response into `OsmWay` records. Tolerant
 * of malformed input (never throws): unparseable JSON, non-way elements, and
 * ways with fewer than two geometry nodes all yield an empty result (or are
 * skipped).
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
    if (!Array.isArray(geometry) || geometry.length < 2) continue;
    if (typeof el.id !== "number") continue;

    const tags = el.tags ?? {};
    const onewayTag = tags.oneway;
    const oneway = onewayTag === "yes" || onewayTag === "true" || onewayTag === "-1";
    const maxspeedKph = tags.maxspeed ? parseMaxspeedKph(tags.maxspeed) : null;

    const way: OsmWay = {
      wayId: el.id,
      coords: geometry.map((node): [number, number] => [node.lon, node.lat]),
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
