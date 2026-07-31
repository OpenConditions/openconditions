import { toIsoTimestamp } from "@openconditions/core";
import { dedupeRoadEvents } from "./dedupe.js";
import { recordSkippedNoGeometry } from "./skip-metrics.js";
import type { RoadEvent, RoadEventType } from "./model.js";
import type { SourceDescriptor } from "./types.js";

/**
 * OHGO's incident/construction resources. Unlike `/travel-delays` (a speed-pair
 * measurement handled by `flow-ohgo.ts`), these are point events: one record per
 * work zone or incident, with an ISO-ish validity window on construction.
 *
 * OHGO's own responses use PascalCase (`Results`, `Latitude`), while its
 * published client wrapper uses camelCase. Both are read here rather than
 * betting on one — the resource is geo-restricted, so the casing can't be
 * pinned from outside the US and getting it wrong would silently yield zero
 * records instead of an error.
 */
type Record_ = Record<string, unknown>;

/** First present value among the given keys, matched case-insensitively. */
function field(r: Record_, ...names: string[]): unknown {
  for (const name of names) {
    if (name in r) return r[name];
    const hit = Object.keys(r).find((k) => k.toLowerCase() === name.toLowerCase());
    if (hit) return r[hit];
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "number") return String(v);
  return undefined;
}

/**
 * OHGO's incident `category` vocabulary. Crash-like categories become
 * `accident`; obstructions and weather become `hazard`; anything unrecognised
 * degrades to `other` so it still reaches the map with its own headline.
 */
const INCIDENT_TYPE_BY_CATEGORY: Record<string, RoadEventType> = {
  crash: "accident",
  accident: "accident",
  "vehicle crash": "accident",
  "disabled vehicle": "hazard",
  "vehicle fire": "hazard",
  debris: "hazard",
  "road debris": "hazard",
  hazard: "hazard",
  flooding: "weather",
  weather: "weather",
  "police activity": "authority",
  closure: "road_closure",
  "road closure": "road_closure",
};

/** OHGO's `roadStatus` vocabulary → the canonical road state. */
const ROAD_STATE_BY_STATUS: Record<string, NonNullable<RoadEvent["roadState"]>> = {
  open: "open",
  closed: "closed",
  "all lanes closed": "closed",
  "lanes closed": "some_lanes_closed",
  "some lanes closed": "some_lanes_closed",
  "alternating traffic": "single_lane_alternating",
};

/** The `{ Results: [...] }` envelope, tolerating either casing. */
function records(input: string | Buffer): Record_[] {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== "object") return [];
  const results = field(payload as Record_, "Results", "results");
  return Array.isArray(results) ? (results as Record_[]) : [];
}

/**
 * Parse an OHGO `/construction` or `/incidents` payload into RoadEvents.
 * Discriminates on the record itself: a `startDate` marks a scheduled work
 * zone, everything else is an unplanned incident. Records without an id or
 * usable coordinates are skipped; a malformed envelope yields [].
 */
export function parseOhgoEvents(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  const now = new Date().toISOString();
  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;

  for (const r of records(input)) {
    const id = str(field(r, "id"));
    const lon = Number(field(r, "longitude"));
    const lat = Number(field(r, "latitude"));
    if (!id || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      skippedNoGeometry++;
      continue;
    }

    const category = str(field(r, "category"));
    const validFrom = toIsoTimestamp(field(r, "startDate"));
    const validTo = toIsoTimestamp(field(r, "endDate"));
    const isWorkZone = field(r, "startDate") != null;

    const type: RoadEventType = isWorkZone
      ? "roadworks"
      : (category && INCIDENT_TYPE_BY_CATEGORY[category.toLowerCase()]) || "other";

    const roadStatus = str(field(r, "roadStatus"));
    const roadState = roadStatus ? ROAD_STATE_BY_STATUS[roadStatus.toLowerCase()] : undefined;
    const road = str(field(r, "routeName"));
    const direction = str(field(r, "direction"));
    const location = str(field(r, "location"));
    const description = str(field(r, "description"));

    out.push({
      id: `${src.id}:${id}`,
      source: src.id,
      sourceFormat: "ohgo-events",
      domain: "roads",
      kind: "event",
      type,
      subtype: category,
      category: isWorkZone ? "planned" : "incident",
      isPlanned: isWorkZone,
      severity: "unknown",
      severitySource: "derived",
      status: "active",
      geometry: { type: "Point", coordinates: [lon, lat] },
      roads: road ? [{ name: road, ...(direction ? { direction } : {}) }] : [],
      ...(roadState ? { roadState } : {}),
      headline: location ?? description ?? road ?? "OHGO event",
      description,
      validFrom: validFrom ?? null,
      validTo: validTo ?? null,
      sourceRaw: r,
      origin: {
        kind: "feed",
        attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
      },
      dataUpdatedAt: toIsoTimestamp(field(r, "lastUpdated")) ?? now,
      fetchedAt: now,
      isStale: false,
    });
  }

  if (skippedNoGeometry > 0) {
    console.debug(
      `[ohgo-events] ${src.id}: skipped ${skippedNoGeometry} record(s) with no usable geometry`
    );
    recordSkippedNoGeometry(src.id, skippedNoGeometry);
  }

  return dedupeRoadEvents(out);
}
