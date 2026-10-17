import { recordSkipped } from "@openconditions/ingest-framework";
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

/** A stated number; NaN for an absent one (a null is not 0). */
const num = (raw: unknown) => (raw == null || raw === "" ? Number.NaN : Number(raw));

/**
 * Parse an OHGO travel-delays payload. OHGO ships a native free-flow speed
 * (`NormalAvgSpeed`) inline per record, so each reading's level of service
 * is computed from its speed against it by the shared threshold ladder. A
 * record without an id or a readable current speed, or with an unreadable
 * position, is skipped as malformed, one without a position as having no
 * geometry.
 */
export function parseOhgoFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  _sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const payload = parseJson(input) as { Results?: unknown } | undefined;
  if (!Array.isArray(payload?.Results)) return { readings: [] };

  const readings: FlowReading[] = [];
  for (const r of payload.Results as Result[]) {
    const id = r?.Id != null ? String(r.Id) : null;
    if (!id) {
      recordSkipped(src.id, "malformed");
      continue;
    }
    const lon = num(r.Longitude);
    const lat = num(r.Latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      const absent =
        (r.Longitude == null || r.Longitude === "") && (r.Latitude == null || r.Latitude === "");
      recordSkipped(src.id, absent ? "no_geometry" : "malformed");
      continue;
    }
    const current = num(r.CurrentAvgSpeed);
    const normal = num(r.NormalAvgSpeed);
    if (!Number.isFinite(current)) {
      recordSkipped(src.id, "malformed");
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
