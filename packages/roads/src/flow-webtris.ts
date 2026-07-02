import type { RoadFlow } from "./model.js";
import type { SourceDescriptor } from "./types.js";
import type { SiteGeometry } from "./siteTable.js";
import { makeOrigin } from "./flow.js";
import type { FlowParseResult } from "./flow.js";

const MPH_TO_KPH = 1.609344;

interface Row {
  "Site Name"?: unknown;
  "Report Date"?: unknown;
  "Time Period Ending"?: unknown;
  "Avg mph"?: unknown;
}

/** Leading numeric token of a WebTRIS "Site Name" (e.g. "5607" from "5607/1 …"). */
function siteToken(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const m = name.match(/\d+/);
  return m ? m[0] : null;
}

/**
 * Parse a WebTRIS daily report into one RoadFlow per site, using the latest row
 * (by report date + period ending) for each site. Average speed is a "NN"
 * string in mph, converted to km/h. Geometry comes from the `/sites` registry
 * map keyed by site id. los stays "unknown"; the baseline enrichment
 * classifies it.
 */
export function parseWebtrisFlow(
  input: string | Buffer,
  src: SourceDescriptor,
  siteMap?: Map<string, SiteGeometry>
): FlowParseResult {
  let payload: { Rows?: unknown };
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return { flows: [], events: [] };
  }
  if (!Array.isArray(payload.Rows)) return { flows: [], events: [] };

  const now = new Date().toISOString();
  const origin = makeOrigin(src);
  const latest = new Map<string, { speedKph: number; measuredAt: string; sort: string }>();

  for (const row of payload.Rows as Row[]) {
    const token = siteToken(row["Site Name"]);
    if (!token) continue;
    const rawMph = row["Avg mph"];
    if (typeof rawMph !== "string" || rawMph.trim() === "") continue;
    const mph = Number(rawMph);
    if (!Number.isFinite(mph) || mph < 0) continue;
    const date = typeof row["Report Date"] === "string" ? row["Report Date"] : "";
    const ending = typeof row["Time Period Ending"] === "string" ? row["Time Period Ending"] : "";
    const sort = `${date}T${ending}`;
    const prev = latest.get(token);
    if (!prev || sort > prev.sort) {
      latest.set(token, { speedKph: mph * MPH_TO_KPH, measuredAt: sort || now, sort });
    }
  }

  const flows: RoadFlow[] = [];
  for (const [token, v] of latest) {
    const geom = siteMap?.get(token);
    if (!geom) continue;
    flows.push({
      id: `${src.id}:${token}`,
      source: src.id,
      sourceFormat: "webtris-json",
      domain: "roads",
      kind: "measurement",
      metric: "flow",
      value: v.speedKph,
      unit: "km/h",
      level: "unknown",
      aggregation: "live",
      status: "active",
      geometry: geom,
      los: "unknown",
      speedKph: v.speedKph,
      origin,
      dataUpdatedAt: v.measuredAt,
      fetchedAt: now,
      isStale: false,
    });
  }
  return { flows, events: [] };
}
