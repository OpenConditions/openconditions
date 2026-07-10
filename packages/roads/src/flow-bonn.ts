import type { LineString } from "geojson";
import type { RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";

type Los = RoadFlow["los"];

/**
 * Bonn publishes `verkehrsstatus` as a German level-of-service phrase. Map the
 * observed phrasings onto the canonical LOS ladder; anything unrecognised stays
 * "unknown" so the baseline enrichment can classify it from the speed instead.
 */
function mapVerkehrsstatus(raw: unknown): Los {
  const s = typeof raw === "string" ? raw.toLowerCase().trim() : "";
  if (s.includes("frei") || s.includes("normal")) return "free_flow";
  if (s.includes("erhöht") || s.includes("erhoeht") || s.includes("dicht")) return "heavy";
  if (s.includes("zäh") || s.includes("zaeh")) return "queuing";
  if (s.includes("stock")) return "queuing";
  if (s.includes("stau") || s.includes("gestaut")) return "stationary";
  return "unknown";
}

const QUEUING_LOS = new Set<Los>(["queuing", "stationary", "blocked"]);

interface BonnFeature {
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
}

/** A GeoJSON [lon,lat][] ring guarded to finite pairs, ≥2 vertices. */
function toLineString(ring: unknown): LineString | null {
  if (!Array.isArray(ring)) return null;
  const coords: [number, number][] = [];
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const lon = Number(pt[0]);
    const lat = Number(pt[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) coords.push([lon, lat]);
  }
  return coords.length >= 2 ? { type: "LineString", coordinates: coords } : null;
}

/**
 * Parse the City of Bonn realtime traffic GeoJSON (`stadtplan.bonn.de/geojson?
 * Thema=19584`) into RoadFlow segments. Each feature is a road section
 * (`strecke_id`) with a `geschwindigkeit` (current speed, km/h), a
 * `verkehrsstatus` level-of-service phrase, and an `auswertezeit` timestamp.
 * MultiLineString geometries emit one RoadFlow per member line so each
 * observation carries a plain LineString (model constraint). A derived
 * congestion RoadEvent is appended when the LOS reaches queuing or worse.
 */
export function parseBonnFlow(input: string | Buffer, src: SourceDescriptor): FlowParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { flows: [], events: [], failed: true };
  }
  const features = (doc as { features?: unknown })?.features;
  if (!Array.isArray(features)) return { flows: [], events: [], failed: true };

  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];
  const events: FlowParseResult["events"] = [];

  for (const raw of features as BonnFeature[]) {
    try {
      const geometry = raw?.geometry;
      const props = raw?.properties ?? {};
      const strecke = props["strecke_id"];
      if (strecke == null) continue;
      const streckeId = String(strecke);

      const geomType = geometry?.type;
      const rings: unknown[] =
        geomType === "MultiLineString"
          ? ((geometry?.coordinates as unknown[]) ?? [])
          : geomType === "LineString"
            ? [geometry?.coordinates]
            : [];

      const speedRaw = props["geschwindigkeit"];
      const speedKph =
        typeof speedRaw === "number" && Number.isFinite(speedRaw) && speedRaw >= 0
          ? speedRaw
          : undefined;
      const los = mapVerkehrsstatus(props["verkehrsstatus"]);
      // Nothing to say if we have neither a resolvable LOS nor a speed.
      if (los === "unknown" && speedKph == null) continue;
      const measuredAt = typeof props["auswertezeit"] === "string" ? props["auswertezeit"] : now;

      const lines = rings.map(toLineString).filter((l): l is LineString => l != null);
      lines.forEach((geom, i) => {
        const lineId = lines.length > 1 ? `${streckeId}:${i}` : streckeId;
        const flow: RoadFlow = {
          id: `${src.id}:${lineId}`,
          source: src.id,
          sourceFormat: "bonn-geojson",
          domain: "roads",
          kind: "measurement",
          metric: "flow",
          ...(speedKph != null ? { value: speedKph, unit: "km/h" } : {}),
          level: los,
          aggregation: "live",
          status: "active",
          geometry: geom,
          los,
          ...(speedKph != null ? { speedKph } : {}),
          origin,
          dataUpdatedAt: measuredAt,
          fetchedAt: now,
          isStale: false,
        };
        flows.push(flow);
        if (QUEUING_LOS.has(los)) {
          events.push({
            id: `${flow.id}:congestion`,
            source: src.id,
            sourceFormat: "bonn-geojson",
            domain: "roads",
            kind: "event",
            type: "congestion",
            category: "conditions",
            isPlanned: false,
            severity: los === "stationary" || los === "blocked" ? "critical" : "high",
            severitySource: "derived",
            headline: `Traffic congestion (${lineId})`,
            status: "active",
            geometry: geom,
            roads: [],
            origin,
            dataUpdatedAt: measuredAt,
            fetchedAt: now,
            isStale: false,
            validFrom: measuredAt,
          });
        }
      });
    } catch (err) {
      console.warn("[bonn-flow] skipped malformed feature:", err);
    }
  }

  return { flows, events };
}
