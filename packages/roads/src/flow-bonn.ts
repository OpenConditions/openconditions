import type { LineString } from "geojson";
import type { FlowContext, FlowSites } from "./flow-output.js";
import type { FlowParse, FlowReading, Los } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

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
 * Thema=19584`). Each feature is a road section (`strecke_id`) with a
 * `geschwindigkeit` (current speed, km/h), a `verkehrsstatus` level-of-service
 * phrase, and an `auswertezeit` timestamp. A MultiLineString section is one
 * site whose member lines each carry the reading (and a derived congestion
 * situation each).
 */
export function parseBonnFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { readings: [], failed: true };
  }
  const features = (doc as { features?: unknown })?.features;
  if (!Array.isArray(features)) return { readings: [], failed: true };

  const readings: FlowReading[] = [];
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
      const at = typeof props["auswertezeit"] === "string" ? props["auswertezeit"] : undefined;

      const lines = rings.map(toLineString).filter((l): l is LineString => l != null);
      lines.forEach((line, i) => {
        readings.push({
          site: streckeId,
          ...(lines.length > 1 ? { line: `${streckeId}:${i}` } : {}),
          geometry: line,
          ...(at !== undefined ? { at } : {}),
          los,
          ...(speedKph != null ? { speedKph } : {}),
        });
      });
    } catch (err) {
      console.warn("[bonn-flow] skipped malformed feature:", err);
    }
  }

  return { readings };
}
