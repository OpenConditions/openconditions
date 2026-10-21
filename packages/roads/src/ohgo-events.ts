import { toIsoTimestamp } from "@openconditions/core";
import { recordSkipped } from "@openconditions/ingest-framework";
import { OHGO_SITUATIONS, ohgoClassification } from "@openconditions/model-roads";
import { dedupeRoadEvents } from "./dedupe.js";
import type { RoadEvent, RoadEventType } from "./model.js";
import { entryOf } from "./situation/location.js";
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
function records(input: string | Buffer): unknown[] {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== "object") return [];
  const results = field(payload as Record_, "Results", "results");
  return Array.isArray(results) ? results : [];
}

/** A coordinate field: absent when the record states none, NaN when it states one that is no number. */
function coordinate(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  return typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
}

/**
 * Parse an OHGO `/construction` or `/incidents` payload into RoadEvents.
 * Discriminates on the record itself: a `startDate` marks a scheduled work
 * zone, everything else is an unplanned incident. Records without
 * coordinates, or with ones off the earth, are left out as having no
 * geometry; records that are no object,
 * have no id or state coordinates that are no numbers as malformed. An
 * incident category or road status the vocabularies do not hold is counted as
 * an unknown value. A malformed envelope yields [].
 */
export function parseOhgoEvents(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  const now = new Date().toISOString();
  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;
  let malformed = 0;
  let unknownValues = 0;

  for (const raw of records(input)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      malformed++;
      continue;
    }
    const r = raw as Record_;
    const id = str(field(r, "id"));
    const lon = coordinate(field(r, "longitude"));
    const lat = coordinate(field(r, "latitude"));
    if (lon === undefined || lat === undefined) {
      skippedNoGeometry++;
      continue;
    }
    if (!id || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      malformed++;
      continue;
    }
    // Numbers that are no position on the earth place nothing.
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      skippedNoGeometry++;
      continue;
    }

    const category = str(field(r, "category"));
    const validFrom = toIsoTimestamp(field(r, "startDate"), src.timeZone);
    const validTo = toIsoTimestamp(field(r, "endDate"), src.timeZone);
    const isWorkZone = field(r, "startDate") != null;

    const type: RoadEventType = isWorkZone
      ? "roadworks"
      : entryOf(INCIDENT_TYPE_BY_CATEGORY, category?.toLowerCase()) || "other";
    const classification = ohgoClassification(category, isWorkZone);
    // A work zone's category only refines it; an incident's is its nature.
    if (!isWorkZone && category && !Object.hasOwn(OHGO_SITUATIONS, category.trim().toLowerCase())) {
      unknownValues++;
    }

    const roadStatus = str(field(r, "roadStatus"));
    const roadState = entryOf(ROAD_STATE_BY_STATUS, roadStatus?.toLowerCase());
    if (roadStatus && roadState === undefined) unknownValues++;
    const road = str(field(r, "routeName"));
    const direction = str(field(r, "direction"));
    const location = str(field(r, "location"));
    const description = str(field(r, "description"));
    const recordTime = toIsoTimestamp(field(r, "lastUpdated"), src.timeZone);

    out.push({
      id: `${src.id}:${id}`,
      source: src.id,
      sourceFormat: "ohgo-events",
      domain: "roads",
      kind: "event",
      situation: {
        ...(classification !== undefined ? { classification } : {}),
        ...(recordTime !== undefined ? { sourceUpdatedAt: recordTime } : {}),
        ...((location ?? description ?? road) ? {} : { headlineFromSource: false as const }),
      },
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
      dataUpdatedAt: toIsoTimestamp(field(r, "lastUpdated"), src.timeZone) ?? now,
      fetchedAt: now,
      isStale: false,
    });
  }

  if (skippedNoGeometry > 0) {
    console.debug(
      `[ohgo-events] ${src.id}: skipped ${skippedNoGeometry} record(s) with no usable geometry`,
    );
    recordSkipped(src.id, "no_geometry", skippedNoGeometry);
  }
  recordSkipped(src.id, "malformed", malformed);
  recordSkipped(src.id, "unknown_value", unknownValues);

  return dedupeRoadEvents(out);
}
