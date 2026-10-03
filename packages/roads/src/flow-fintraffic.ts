import type { DirectionRef } from "@openconditions/model";
import type { FlowContext, FlowSites } from "./flow-output.js";
import { type FlowParse, type FlowReading, parseJson, plausibleSpeed } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

/** The sliding five-minute sensors, by direction; their value is already an hourly rate for volumes. */
const SPEED_SENSORS: Record<string, "1" | "2"> = {
  KESKINOPEUS_5MIN_LIUKUVA_SUUNTA1: "1",
  KESKINOPEUS_5MIN_LIUKUVA_SUUNTA2: "2",
};
const VOLUME_SENSORS: Record<string, "1" | "2"> = {
  OHITUKSET_5MIN_LIUKUVA_SUUNTA1: "1",
  OHITUKSET_5MIN_LIUKUVA_SUUNTA2: "2",
};
const SLIDING_PERIOD_SEC = 300;

/** Digitraffic direction 1 runs with increasing road address, direction 2 against it. */
const DIRECTIONS: Record<"1" | "2", DirectionRef> = {
  "1": { value: "positive", basis: "road_reference" },
  "2": { value: "negative", basis: "road_reference" },
};

interface SensorValue {
  name?: unknown;
  value?: unknown;
  measuredTime?: unknown;
}
interface Station {
  id?: unknown;
  dataUpdatedTime?: unknown;
  sensorValues?: unknown;
}

/**
 * Parse a Fintraffic TMS `/stations/data` JSON payload. Each direction of a
 * station is its own measurement site (`<station>-<direction>`), as its
 * native free-flow constants are: the five-minute sliding average speed and
 * the five-minute sliding passing count (vehicles per hour) of that
 * direction. Geometry and name come from the station registry. The level of
 * service is left to the baseline enrichment.
 */
export function parseFintrafficFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const payload = parseJson(input) as { stations?: unknown } | undefined;
  if (payload === undefined || payload === null || typeof payload !== "object") {
    return { readings: [] };
  }
  const stations = payload.stations;
  if (!Array.isArray(stations)) return { readings: [] };

  const readings: FlowReading[] = [];
  for (const raw of stations as Station[]) {
    const stationId = raw?.id != null ? String(raw.id) : null;
    if (stationId == null) continue;
    const station = sites?.get(stationId);
    if (!station) continue;
    const sensors = Array.isArray(raw.sensorValues) ? (raw.sensorValues as SensorValue[]) : [];
    const timeOf = (s: SensorValue) =>
      typeof s.measuredTime === "string"
        ? s.measuredTime
        : typeof raw.dataUpdatedTime === "string"
          ? raw.dataUpdatedTime
          : undefined;
    const byDirection = new Map<"1" | "2", { speed?: number; volume?: number; at?: string }>();
    for (const s of sensors) {
      const name = typeof s.name === "string" ? s.name : "";
      const value = typeof s.value === "number" ? s.value : Number.NaN;
      const speedDir = SPEED_SENSORS[name];
      const volumeDir = VOLUME_SENSORS[name];
      const dir = speedDir ?? volumeDir;
      if (dir === undefined) continue;
      const entry = byDirection.get(dir) ?? {};
      if (speedDir !== undefined && plausibleSpeed(value)) {
        entry.speed = value;
        entry.at = timeOf(s) ?? entry.at;
      } else if (volumeDir !== undefined && Number.isFinite(value) && value >= 0) {
        entry.volume = value;
        entry.at ??= timeOf(s);
      }
      byDirection.set(dir, entry);
    }
    for (const [dir, entry] of [...byDirection].sort(([a], [b]) => a.localeCompare(b))) {
      if (entry.speed === undefined && entry.volume === undefined) continue;
      readings.push({
        site: `${stationId}-${dir}`,
        geometry: station.geometry,
        ...(entry.at !== undefined ? { at: entry.at } : {}),
        periodSec: SLIDING_PERIOD_SEC,
        los: "unknown",
        ...(entry.speed !== undefined ? { speedKph: entry.speed } : {}),
        ...(entry.volume !== undefined ? { volume: entry.volume } : {}),
        direction: `SUUNTA${dir}`,
        directionRef: DIRECTIONS[dir],
        ...(station.name !== undefined ? { name: station.name, nameLang: "fi" } : {}),
      });
    }
  }
  return { readings };
}
