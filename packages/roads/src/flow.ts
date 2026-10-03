/**
 * Shared helpers of the flow parsers, and the Digitraffic traffic-measurement
 * parser. Every flow parser reads one payload into the parse-local
 * {@link FlowReading}s the site assembler drafts features, readings and
 * derived congestion situations from.
 */
import { zonedWallClockToInstant } from "@openconditions/model";
import type { LineString } from "geojson";
import type { FlowContext } from "./flow-output.js";
import type { FlowParse, FlowReading, Los } from "./flow-reading.js";
import { parseJson } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

/**
 * A source's zoneless local timestamp (`YYYY-MM-DDTHH:mm[:ss[.fff]]`) read in
 * the publisher's time zone, as an ISO instant; undefined when unreadable.
 */
export function localTimestamp(wallClock: string, timeZone: string): string | undefined {
  const at = zonedWallClockToInstant(timeZone, wallClock.trim().replace(/\.\d+$/, ""));
  return at === null ? undefined : at.toISOString();
}

function mapDigitrafficCongestionLevel(raw: unknown): Los {
  switch (typeof raw === "string" ? raw.toUpperCase() : "") {
    case "FREE_FLOW":
    case "LIGHT":
      return "free_flow";
    case "HEAVY":
      return "heavy";
    case "QUEUING":
      return "queuing";
    case "STATIONARY":
      return "stationary";
    case "BLOCKED":
      return "blocked";
    default:
      return "unknown";
  }
}

/**
 * Parse a Digitraffic traffic-measurement GeoJSON feed: one reading per
 * segment, with its stated congestion level, average speed and the feed's
 * own free-flow speed. A MultiLineString segment is one site whose member
 * lines each carry the reading (and a derived congestion situation each).
 * Features without line geometry are skipped.
 */
export function parseDigitrafficFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  _sites: unknown,
  _ctx: FlowContext,
): FlowParse {
  const payload = parseJson(input);
  // An unreadable body or a non-object is an error page, not an empty feed.
  if (!payload || typeof payload !== "object") return { readings: [], failed: true };
  const features = (payload as Record<string, unknown>)["features"];
  if (!Array.isArray(features)) return { readings: [] };

  const readings: FlowReading[] = [];
  for (const rawFeature of features) {
    if (!rawFeature || typeof rawFeature !== "object") continue;
    const feature = rawFeature as Record<string, unknown>;
    const geometry = feature["geometry"] as Record<string, unknown> | null | undefined;
    if (!geometry || typeof geometry !== "object" || !Array.isArray(geometry["coordinates"])) {
      continue;
    }
    const geomType = geometry["type"];
    if (geomType !== "LineString" && geomType !== "MultiLineString") continue;

    const props = (feature["properties"] ?? {}) as Record<string, unknown>;
    const featureId = typeof props["id"] === "string" ? props["id"] : `flow-${readings.length + 1}`;
    const los = mapDigitrafficCongestionLevel(props["congestionLevel"]);
    const speedKph = typeof props["averageSpeed"] === "number" ? props["averageSpeed"] : undefined;
    const freeFlowKph =
      typeof props["freeFlowSpeed"] === "number" && props["freeFlowSpeed"] > 0
        ? props["freeFlowSpeed"]
        : undefined;
    const name = typeof props["name"] === "string" ? props["name"] : undefined;

    const lines: LineString[] =
      geomType === "MultiLineString"
        ? (geometry["coordinates"] as [number, number][][]).map((coordinates) => ({
            type: "LineString",
            coordinates,
          }))
        : [{ type: "LineString", coordinates: geometry["coordinates"] as [number, number][] }];

    lines.forEach((line, i) => {
      readings.push({
        site: featureId,
        ...(lines.length > 1 ? { line: `${featureId}:${i}` } : {}),
        geometry: line,
        ...(typeof props["measuredTime"] === "string" ? { at: props["measuredTime"] } : {}),
        los,
        ...(speedKph !== undefined ? { speedKph } : {}),
        ...(freeFlowKph !== undefined ? { freeFlowKph, freeFlowSource: "native" as const } : {}),
        ...(speedKph !== undefined && freeFlowKph !== undefined
          ? { speedRatio: speedKph / freeFlowKph }
          : {}),
        ...(name !== undefined ? { name, nameLang: "fi" } : {}),
      });
    });
  }
  return { readings };
}
