import { normaliseSeverity } from "@openconditions/core";
import type { GeoJsonGeometry, RecurringWindow } from "@openconditions/core";
import type { RoadEvent, RoadRef } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
import { mapSourceType } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";

interface Open511Road {
  name?: string;
  from?: string;
  to?: string;
  direction?: string;
  state?: string;
}

interface Open511RecurringSchedule {
  days?: number[];
  daily_start_time?: string;
  daily_end_time?: string;
}

interface Open511Schedule {
  intervals?: string[];
  recurring_schedules?: Open511RecurringSchedule[];
}

interface Open511Event {
  id?: string;
  status?: string;
  headline?: string;
  description?: string;
  event_type?: string;
  event_subtypes?: unknown;
  severity?: string;
  geography?: GeoJsonGeometry;
  roads?: Open511Road[];
  schedule?: Open511Schedule;
  updated?: string;
  [key: string]: unknown;
}

/** Open511 recurring_schedules → canonical RecurringWindow[]. */
function parseRecurring(schedule: Open511Schedule | undefined): RecurringWindow[] | undefined {
  const rs = schedule?.recurring_schedules;
  if (!Array.isArray(rs) || rs.length === 0) return undefined;
  const out = rs.map((r) => {
    const w: RecurringWindow = {};
    if (Array.isArray(r.days)) {
      const days = r.days.filter((d): d is number => typeof d === "number");
      if (days.length > 0) w.dayOfWeek = days;
    }
    if (typeof r.daily_start_time === "string") w.timeStart = r.daily_start_time;
    if (typeof r.daily_end_time === "string") w.timeEnd = r.daily_end_time;
    return w;
  });
  return out.length > 0 ? out : undefined;
}

function firstSubtype(event_subtypes: unknown): string | undefined {
  return Array.isArray(event_subtypes) && typeof event_subtypes[0] === "string"
    ? event_subtypes[0]
    : undefined;
}

interface Open511Payload {
  events?: Open511Event[];
  [key: string]: unknown;
}

function localId(rawId: string): string {
  const lastSlash = rawId.lastIndexOf("/");
  return lastSlash >= 0 ? rawId.slice(lastSlash + 1) : rawId;
}

function parseSchedule(schedule: Open511Schedule | undefined): {
  validFrom: string | null;
  validTo: string | null;
} {
  const interval = schedule?.intervals?.[0];
  if (!interval) return { validFrom: null, validTo: null };

  const slashIdx = interval.indexOf("/");
  if (slashIdx < 0) return { validFrom: interval, validTo: null };

  return {
    validFrom: interval.slice(0, slashIdx) || null,
    validTo: interval.slice(slashIdx + 1) || null,
  };
}

function parseRoads(roads: Open511Road[] | undefined): RoadRef[] {
  if (!roads || roads.length === 0) return [];

  return roads.map((r) => {
    const ref: RoadRef = { name: r.name ?? "" };
    if (r.from != null) ref.from = r.from;
    if (r.to != null) ref.to = r.to;
    if (r.direction != null) ref.direction = r.direction;
    return ref;
  });
}

/** Open511 road `state` enum → canonical roadState (worst across all roads). */
function open511RoadState(state: string | undefined): RoadEvent["roadState"] | undefined {
  switch (state?.toUpperCase()) {
    case "CLOSED":
    case "ALL_LANES_CLOSED":
      return "closed";
    case "SOME_LANES_CLOSED":
      return "some_lanes_closed";
    case "SINGLE_LANE_ALTERNATING":
      return "single_lane_alternating";
    case "ALL_LANES_OPEN":
      return "open";
    default:
      return undefined;
  }
}

const ROAD_STATE_SEVERITY: NonNullable<RoadEvent["roadState"]>[] = [
  "open",
  "single_lane_alternating",
  "some_lanes_closed",
  "closed",
];

function roadStateFromRoads(roads: Open511Road[] | undefined): RoadEvent["roadState"] | undefined {
  let worst: RoadEvent["roadState"] | undefined;
  for (const r of roads ?? []) {
    const s = open511RoadState(r.state);
    if (
      s &&
      (worst == null || ROAD_STATE_SEVERITY.indexOf(s) > ROAD_STATE_SEVERITY.indexOf(worst))
    ) {
      worst = s;
    }
  }
  return worst;
}

function collectExtensionFields(ev: Open511Event): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ev)) {
    if (key.startsWith("+")) {
      out[key] = ev[key];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function open511Status(raw: string | undefined): "active" | "inactive" | "archived" | "cancelled" {
  switch (raw?.toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "INACTIVE":
      return "inactive";
    case "ARCHIVED":
      return "archived";
    case "CANCELLED":
      return "cancelled";
    default:
      return "active";
  }
}

/**
 * Parse an Open511 JSON feed and return an array of RoadEvent observations.
 * Events with no usable geometry are skipped. Extension fields (prefixed with
 * "+") are collected into externalRefs. The result is deduped before return.
 */
export function parseOpen511(json: string | Buffer | object, src: SourceDescriptor): RoadEvent[] {
  let payload: Open511Payload;
  try {
    const str = Buffer.isBuffer(json) ? json.toString("utf8") : json;
    payload = (typeof str === "string" ? JSON.parse(str) : str) as Open511Payload;
  } catch (err) {
    console.warn("[open511] failed to parse JSON input:", err);
    return [];
  }

  const events = payload.events;
  if (!Array.isArray(events) || events.length === 0) return [];

  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;

  for (const ev of events) {
    try {
      const geometry = ev.geography ?? null;
      if (!geometry || typeof geometry !== "object" || !("type" in geometry)) {
        skippedNoGeometry++;
        continue;
      }

      const eventType = typeof ev.event_type === "string" ? ev.event_type : "";
      const { type, category, isPlanned } = mapSourceType("open511", eventType);

      const severityRaw = typeof ev.severity === "string" ? ev.severity : "UNKNOWN";
      const { validFrom, validTo } = parseSchedule(ev.schedule);

      const rawId =
        typeof ev.id === "string" ? ev.id : `unknown-${Math.random().toString(36).slice(2)}`;
      const eventLocalId = localId(rawId);

      const extensionFields = collectExtensionFields(ev);
      const externalRefs: RoadEvent["externalRefs"] = extensionFields
        ? ({ linear: extensionFields } as RoadEvent["externalRefs"])
        : undefined;

      out.push({
        id: `${src.id}:${eventLocalId}`,
        source: src.id,
        sourceFormat: "open511",
        domain: "roads",
        kind: "event",
        type,
        subtype: firstSubtype(ev.event_subtypes) ?? eventType ?? undefined,
        category,
        isPlanned,
        ...normaliseSeverity(severityRaw, { format: "open511" }),
        status: open511Status(ev.status),
        geometry: geometry as GeoJsonGeometry,
        roads: parseRoads(ev.roads),
        roadState: roadStateFromRoads(ev.roads),
        headline: typeof ev.headline === "string" && ev.headline ? ev.headline : type,
        description: typeof ev.description === "string" ? ev.description : undefined,
        schedule: parseRecurring(ev.schedule),
        validFrom,
        validTo,
        externalRefs,
        sourceRaw: ev as Record<string, unknown>,
        origin: {
          kind: "feed",
          attribution: {
            provider: src.attribution,
            license: src.license,
            url: src.licenseUrl,
          },
        },
        dataUpdatedAt: typeof ev.updated === "string" ? ev.updated : new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        isStale: false,
      });
    } catch (err) {
      console.warn("[open511] skipped malformed event:", ev?.["id"], err);
    }
  }

  if (skippedNoGeometry > 0) {
    console.debug(`[open511] skipped ${skippedNoGeometry} event(s) with no usable geometry`);
  }

  return dedupeRoadEvents(out);
}
