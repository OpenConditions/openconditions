import type { LineString } from "geojson";
import type { RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";

interface SpeedBandRow {
  LinkID?: unknown;
  SpeedBand?: unknown;
  MinimumSpeed?: unknown;
  MaximumSpeed?: unknown;
  StartLon?: unknown;
  StartLat?: unknown;
  EndLon?: unknown;
  EndLat?: unknown;
}

function num(raw: unknown): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse the LTA DataMall Traffic Speed Bands (v2/v3) JSON — records under a
 * top-level `value` array — into RoadFlow segments. Each link carries a
 * `SpeedBand` (1–8) and a `MinimumSpeed`/`MaximumSpeed` band in km/h; the
 * representative speed is the band midpoint. Geometry is the Start→End
 * coordinate pair as a two-point LineString. los is left "unknown" (absolute
 * speed is road-class–dependent) so the baseline enrichment classifies it.
 *
 * DataMall pages this resource 500 links per call via `$skip`; a single fetch
 * therefore covers the first page only. Full coverage needs paging support in
 * the ingest fetch layer, which is why the feed ships `enabledByDefault:false`.
 */
export function parseLtaSpeedBands(input: string | Buffer, src: SourceDescriptor): FlowParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { flows: [], events: [], failed: true };
  }
  const rows = (doc as { value?: unknown })?.value;
  if (!Array.isArray(rows)) return { flows: [], events: [], failed: true };

  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];

  for (const raw of rows as SpeedBandRow[]) {
    try {
      const linkId = raw?.LinkID != null ? String(raw.LinkID) : null;
      if (!linkId) continue;

      const startLon = num(raw.StartLon);
      const startLat = num(raw.StartLat);
      const endLon = num(raw.EndLon);
      const endLat = num(raw.EndLat);
      if (startLon == null || startLat == null || endLon == null || endLat == null) continue;
      const geometry: LineString = {
        type: "LineString",
        coordinates: [
          [startLon, startLat],
          [endLon, endLat],
        ],
      };

      const min = num(raw.MinimumSpeed);
      const max = num(raw.MaximumSpeed);
      // Band midpoint; the top band (e.g. "70"/"") is open-ended, so fall back
      // to whichever bound is present.
      const speedKph = min != null && max != null ? (min + max) / 2 : (max ?? min ?? undefined);
      if (speedKph == null) continue;

      flows.push({
        id: `${src.id}:${linkId}`,
        source: src.id,
        sourceFormat: "lta-speedbands",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        value: speedKph,
        unit: "km/h",
        level: "unknown",
        aggregation: "live",
        status: "active",
        geometry,
        los: "unknown",
        speedKph,
        origin,
        dataUpdatedAt: now,
        fetchedAt: now,
        isStale: false,
      });
    } catch (err) {
      console.warn("[lta-speedbands] skipped malformed row:", err);
    }
  }

  return { flows, events: [] };
}
