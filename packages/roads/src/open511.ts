import { normaliseSeverity } from "@openconditions/core";
import type { GeoJsonGeometry } from "@openconditions/core";
import type { RoadEvent, RoadRef } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
import { mapSourceType } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";

interface Open511Road {
  name?: string;
  from?: string;
  to?: string;
  direction?: string;
}

interface Open511Schedule {
  intervals?: string[];
}

interface Open511Event {
  id?: string;
  status?: string;
  headline?: string;
  description?: string;
  event_type?: string;
  event_subtypes?: string[];
  severity?: string;
  geography?: GeoJsonGeometry;
  roads?: Open511Road[];
  schedule?: Open511Schedule;
  updated?: string;
  [key: string]: unknown;
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
export function parseOpen511(json: string | object, src: SourceDescriptor): RoadEvent[] {
  let payload: Open511Payload;
  try {
    payload = (typeof json === "string" ? JSON.parse(json) : json) as Open511Payload;
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
        subtype: eventType || undefined,
        category,
        isPlanned,
        ...normaliseSeverity(severityRaw, { format: "open511" }),
        status: open511Status(ev.status),
        geometry: geometry as GeoJsonGeometry,
        roads: parseRoads(ev.roads),
        headline: typeof ev.headline === "string" && ev.headline ? ev.headline : type,
        description: typeof ev.description === "string" ? ev.description : undefined,
        validFrom,
        validTo,
        externalRefs,
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
