import type { RoadEvent, RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import { makeOrigin, reclassifyFlow } from "./flow.js";
import type { FlowParseResult } from "./flow.js";

const MPH_TO_KPH = 1.609344;

interface Result {
  Id?: unknown;
  Latitude?: unknown;
  Longitude?: unknown;
  CurrentAvgSpeed?: unknown;
  NormalAvgSpeed?: unknown;
  Direction?: unknown;
  LastUpdated?: unknown;
}

/**
 * Parse an OHGO travel-delays payload into RoadFlow measurements. OHGO ships a
 * native free-flow (`NormalAvgSpeed`) inline per record, so each flow is built
 * with its speed and run through reclassifyFlow with the native baseline — the
 * shared threshold ladder does the classification and emits congestion events.
 */
export function parseOhgoFlow(input: string | Buffer, src: SourceDescriptor): FlowParseResult {
  let payload: { Results?: unknown };
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { flows: [], events: [] };
  }
  if (!Array.isArray(payload.Results)) return { flows: [], events: [] };

  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const flows: RoadFlow[] = [];
  const events: RoadEvent[] = [];

  for (const r of payload.Results as Result[]) {
    const id = r?.Id != null ? String(r.Id) : null;
    const lon = Number(r.Longitude);
    const lat = Number(r.Latitude);
    const current = Number(r.CurrentAvgSpeed);
    const normal = Number(r.NormalAvgSpeed);
    if (!id || !Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(current)) {
      continue;
    }
    const measuredAt = typeof r.LastUpdated === "string" ? r.LastUpdated : now;
    const base: RoadFlow = {
      id: `${src.id}:${id}`,
      source: src.id,
      sourceFormat: "ohgo",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      value: current * MPH_TO_KPH,
      unit: "km/h",
      level: "unknown",
      aggregation: "live",
      status: "active",
      geometry: { type: "Point", coordinates: [lon, lat] },
      los: "unknown",
      speedKph: current * MPH_TO_KPH,
      ...(typeof r.Direction === "string" && r.Direction ? { direction: r.Direction } : {}),
      origin,
      dataUpdatedAt: measuredAt,
      fetchedAt: now,
      isStale: false,
    };
    if (Number.isFinite(normal) && normal > 0) {
      const { flow, event } = reclassifyFlow(base, normal * MPH_TO_KPH, "native", src);
      flows.push(flow);
      if (event) events.push(event);
    } else {
      flows.push(base);
    }
  }
  return { flows, events };
}
