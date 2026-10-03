import type { FlowContext, FlowSites } from "./flow-output.js";
import { type FlowParse, type FlowReading, measuredReading, parseJson } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

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
 * Parse an OHGO travel-delays payload. OHGO ships a native free-flow speed
 * (`NormalAvgSpeed`) inline per record, so each reading's level of service
 * is computed from its speed against it by the shared threshold ladder.
 */
export function parseOhgoFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const payload = parseJson(input) as { Results?: unknown } | undefined;
  if (!Array.isArray(payload?.Results)) return { readings: [] };

  const readings: FlowReading[] = [];
  for (const r of payload.Results as Result[]) {
    const id = r?.Id != null ? String(r.Id) : null;
    const lon = Number(r.Longitude);
    const lat = Number(r.Latitude);
    const current = Number(r.CurrentAvgSpeed);
    const normal = Number(r.NormalAvgSpeed);
    if (!id || !Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(current)) {
      continue;
    }
    const reading = measuredReading({
      site: id,
      geometry: { type: "Point", coordinates: [lon, lat] },
      ...(typeof r.LastUpdated === "string" ? { at: r.LastUpdated } : {}),
      speedKph: current * MPH_TO_KPH,
      ...(Number.isFinite(normal) && normal > 0 ? { freeFlowKph: normal * MPH_TO_KPH } : {}),
      ...(typeof r.Direction === "string" && r.Direction ? { direction: r.Direction } : {}),
    });
    if (reading) readings.push(reading);
  }
  return { readings };
}
