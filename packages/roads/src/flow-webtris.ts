import { localTimestamp } from "./flow.js";
import type { FlowContext, FlowSites } from "./flow-output.js";
import { type FlowParse, type FlowReading, parseJson, plausibleSpeed } from "./flow-reading.js";
import type { SourceDescriptor } from "./types.js";

const MPH_TO_KPH = 1.609344;
/** A WebTRIS report row covers the quarter hour ending at its "Time Period Ending". */
const PERIOD_SEC = 900;

interface Row {
  "Site Name"?: unknown;
  "Report Date"?: unknown;
  "Time Period Ending"?: unknown;
  "Avg mph"?: unknown;
  "Total Volume"?: unknown;
}

/** Leading numeric token of a WebTRIS "Site Name" (e.g. "5607" from "5607/1 …"). */
function siteToken(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const m = name.match(/\d+/);
  return m ? m[0] : null;
}

const numeric = (raw: unknown) =>
  typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;

/**
 * Parse a WebTRIS daily report into one reading per site, from the latest
 * row (by report date + period ending) of each: the average speed (mph,
 * converted to km/h) and the quarter-hour's total count as an hourly volume,
 * over the period the row covers. Geometry and name come from the `/sites`
 * registry. The level of service is left to the baseline enrichment.
 */
export function parseWebtrisFlow(
  input: string | Buffer,
  _src: SourceDescriptor,
  sites: FlowSites | undefined,
  _ctx: FlowContext,
): FlowParse {
  const payload = parseJson(input) as { Rows?: unknown } | undefined;
  if (!Array.isArray(payload?.Rows)) return { readings: [] };

  const latest = new Map<
    string,
    { speedKph?: number; volume?: number; at: string | undefined; sort: string }
  >();
  for (const row of payload.Rows as Row[]) {
    const token = siteToken(row["Site Name"]);
    if (!token) continue;
    const mph = numeric(row["Avg mph"]);
    const speedKph = Number.isFinite(mph) && mph >= 0 ? mph * MPH_TO_KPH : undefined;
    const count = numeric(row["Total Volume"]);
    const volume = Number.isFinite(count) && count >= 0 ? count * (3600 / PERIOD_SEC) : undefined;
    if (!plausibleSpeed(speedKph) && volume === undefined) continue;
    // "Report Date" is a midnight timestamp ("2026-03-04T00:00:00"); the period
    // ending is the UK wall-clock time of day the row covers up to.
    const date = typeof row["Report Date"] === "string" ? row["Report Date"].slice(0, 10) : "";
    const ending = typeof row["Time Period Ending"] === "string" ? row["Time Period Ending"] : "";
    const sort = `${date}T${ending}`;
    const prev = latest.get(token);
    if (!prev || sort > prev.sort) {
      latest.set(token, {
        ...(plausibleSpeed(speedKph) ? { speedKph } : {}),
        ...(volume !== undefined ? { volume } : {}),
        at: localTimestamp(sort, "Europe/London"),
        sort,
      });
    }
  }

  const readings: FlowReading[] = [];
  for (const [token, v] of latest) {
    const site = sites?.get(token);
    if (!site) continue;
    readings.push({
      site: token,
      geometry: site.geometry,
      ...(v.at !== undefined ? { at: v.at } : {}),
      periodSec: PERIOD_SEC,
      los: "unknown",
      ...(v.speedKph !== undefined ? { speedKph: v.speedKph } : {}),
      ...(v.volume !== undefined ? { volume: v.volume } : {}),
      ...(site.name !== undefined ? { name: site.name, nameLang: "en" } : {}),
    });
  }
  return { readings };
}
