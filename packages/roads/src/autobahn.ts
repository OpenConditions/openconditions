import { deriveSeverity } from "@openconditions/core";
import type { GeoJsonGeometry } from "@openconditions/core";
import type { LaneStatus, RoadEvent, RoadRef } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
import { mapSourceType } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";

interface AutobahnCoordinate {
  lat?: unknown;
  long?: unknown;
}

interface AutobahnGeometry {
  type?: string;
  coordinates?: unknown;
}

interface AutobahnItem {
  identifier?: unknown;
  id?: unknown;
  title?: unknown;
  subtitle?: unknown;
  description?: unknown;
  isBlocked?: unknown;
  startTimestamp?: unknown;
  coordinate?: AutobahnCoordinate;
  geometry?: AutobahnGeometry;
  delayTimeValue?: unknown;
  averageSpeed?: unknown;
  abnormalTrafficType?: unknown;
  [key: string]: unknown;
}

interface AutobahnPayload {
  [service: string]: AutobahnItem[] | undefined;
}

function parseGeometry(item: AutobahnItem): GeoJsonGeometry | null {
  const geo = item.geometry;
  if (geo && typeof geo === "object" && typeof geo.type === "string" && geo.coordinates != null) {
    return geo as unknown as GeoJsonGeometry;
  }

  const coord = item.coordinate;
  if (coord && typeof coord === "object") {
    const lat = Number(coord.lat);
    const lon = Number(coord.long);
    if (!isNaN(lat) && !isNaN(lon)) {
      return { type: "Point", coordinates: [lon, lat] };
    }
  }

  return null;
}

/** Autobahn titles lead with the road designation, e.g.
 * "A5 | Karlsruhe-Nord - Bruchsal" (Bundesstraßen use "B<n>"). */
function roadsFromTitle(title: string | undefined): RoadRef[] {
  const head = title?.split("|")[0]?.trim() ?? "";
  const m = head.match(/^([AB])\s?(\d+\w*)/i);
  if (!m) return [];
  const ref = `${m[1]!.toUpperCase()}${m[2]}`;
  return [{ name: ref, ref }];
}

/** The Autobahn lane diagram (impact.symbols) → lane statuses; CLOSED/ARROW/
 * BREAKDOWN are lanes, BORDER/SEPARATE are dividers (ignored). */
function laneSymbolsToLanes(symbols: unknown): {
  lanes: LaneStatus[];
  closed: number;
  total: number;
} {
  const LANE = new Set(["CLOSED", "ARROW_UP", "ARROW_DOWN", "BREAKDOWN_LANE"]);
  const lanes: LaneStatus[] = [];
  let closed = 0;
  if (Array.isArray(symbols)) {
    for (const s of symbols) {
      if (typeof s !== "string" || !LANE.has(s)) continue;
      if (s === "CLOSED") closed++;
      lanes.push({
        index: lanes.length + 1,
        status: s === "CLOSED" ? "closed" : "open",
        ...(s === "BREAKDOWN_LANE" ? { type: "breakdown" } : {}),
      });
    }
  }
  return { lanes, closed, total: lanes.length };
}

/** routeRecommendation is a string or array of recommended-alternative strings. */
function detourFromRecommendation(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (Array.isArray(raw)) {
    const parts = raw.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  return undefined;
}

function hasFlowFields(item: AutobahnItem): boolean {
  return (
    item.delayTimeValue != null || item.averageSpeed != null || item.abnormalTrafficType != null
  );
}

function coerceTimestamp(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  if (raw.trim() === "") return null;

  const d = new Date(raw);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }

  const german = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (german) {
    const [, day, month, year, hour, minute, second = "00"] = german;
    const fullYear = year && year.length === 2 ? `20${year}` : (year ?? "");
    const iso = `${fullYear}-${(month ?? "").padStart(2, "0")}-${(day ?? "").padStart(2, "0")}T${(hour ?? "").padStart(2, "0")}:${(minute ?? "").padStart(2, "0")}:${second.padStart(2, "0")}`;
    const d2 = new Date(iso);
    return isNaN(d2.getTime()) ? null : d2.toISOString();
  }

  return null;
}

function joinDescription(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) {
    return typeof raw === "string" && raw ? raw : undefined;
  }
  const parts = (raw as unknown[]).filter(
    (s): s is string => typeof s === "string" && s.trim() !== ""
  );
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Parse an Autobahn GmbH JSON feed and return an array of RoadEvent observations.
 * Items lacking any usable geometry are skipped. The result is deduped before return.
 *
 * Format gotchas handled:
 * - coordinate key is `long` (not `lng`/`lon`)
 * - `isBlocked` is a string ("true"/"false")
 * - `description` is a string array
 * - `startTimestamp` may be null or a German-locale date string
 * - flow fields signal congestion type
 */
const AUTOBAHN_SERVICES = ["warning", "closure", "roadworks"] as const;
type AutobahnService = (typeof AUTOBAHN_SERVICES)[number];

function detectService(payload: AutobahnPayload): AutobahnService | undefined {
  for (const key of AUTOBAHN_SERVICES) {
    if (Array.isArray(payload[key])) return key;
  }
  return undefined;
}

export function parseAutobahn(
  json: string | Buffer | object,
  src: SourceDescriptor,
  service?: "warning" | "closure" | "roadworks"
): RoadEvent[] {
  let payload: AutobahnPayload;
  try {
    const str = Buffer.isBuffer(json) ? json.toString("utf8") : json;
    payload = (typeof str === "string" ? JSON.parse(str) : str) as AutobahnPayload;
  } catch (err) {
    console.warn("[autobahn] failed to parse JSON input:", err);
    return [];
  }

  const resolvedService = service ?? detectService(payload);
  if (!resolvedService) return [];

  const items = payload[resolvedService];
  if (!Array.isArray(items) || items.length === 0) return [];

  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;
  let localCounter = 0;

  for (const item of items) {
    try {
      const geometry = parseGeometry(item);
      if (!geometry) {
        skippedNoGeometry++;
        console.debug(
          `[autobahn] skipped item with no usable geometry: ${String(item.identifier ?? item.id ?? "unknown")}`
        );
        continue;
      }

      localCounter++;
      const rawId =
        typeof item.identifier === "string"
          ? item.identifier
          : typeof item.id === "string"
            ? item.id
            : `autobahn-${localCounter}`;

      const isFlow = hasFlowFields(item);

      let type: RoadEvent["type"];
      let category: RoadEvent["category"];
      let isPlanned: boolean;

      if (isFlow) {
        type = "congestion";
        category = "conditions";
        isPlanned = false;
      } else {
        const mapped = mapSourceType("autobahn", resolvedService);
        type = mapped.type;
        category = mapped.category;
        isPlanned = mapped.isPlanned;
      }

      const impact =
        item.impact && typeof item.impact === "object"
          ? (item.impact as { lower?: unknown; upper?: unknown; symbols?: unknown })
          : undefined;
      const { lanes, closed, total } = laneSymbolsToLanes(impact?.symbols);
      // The lane diagram is the real lane signal (isBlocked is uniformly "false").
      const symbolRoadState: RoadEvent["roadState"] | undefined =
        total > 0 && closed > 0 ? (closed < total ? "some_lanes_closed" : "closed") : undefined;
      const roadState: RoadEvent["roadState"] =
        item.isBlocked === "true" ? "closed" : symbolRoadState;
      const lanesAffected: RoadEvent["lanesAffected"] =
        total > 0 ? { total, closed, lanes } : undefined;

      const severity = deriveSeverity({ roadState, lanesAffected });

      const title = typeof item.title === "string" ? item.title : undefined;
      const subtitle = typeof item.subtitle === "string" ? item.subtitle.trim() : undefined;
      const headline = title ?? subtitle ?? type;

      const description = joinDescription(item.description);

      const validFrom = coerceTimestamp(item.startTimestamp);

      const roads = roadsFromTitle(title);
      if (roads[0]) {
        if (typeof impact?.lower === "string") roads[0].from = impact.lower;
        if (typeof impact?.upper === "string") roads[0].to = impact.upper;
      }

      out.push({
        id: `${src.id}:${rawId}`,
        source: src.id,
        sourceFormat: "autobahn-json",
        domain: "roads",
        kind: "event",
        type,
        subtype: typeof item.display_type === "string" ? item.display_type : undefined,
        category,
        isPlanned,
        severity,
        severitySource: "derived",
        status: "active",
        geometry,
        roads,
        ...(subtitle ? { direction: subtitle } : {}),
        roadState,
        lanesAffected,
        detour: detourFromRecommendation(item.routeRecommendation),
        isForecast: item.future === true,
        sourceRaw: item as Record<string, unknown>,
        headline,
        description,
        validFrom,
        validTo: null,
        origin: {
          kind: "feed",
          attribution: {
            provider: src.attribution,
            license: src.license,
            url: src.licenseUrl,
          },
        },
        dataUpdatedAt: validFrom ?? new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        isStale: false,
      });
    } catch (err) {
      console.warn("[autobahn] skipped malformed item:", item?.identifier ?? item?.id, err);
    }
  }

  if (skippedNoGeometry > 0) {
    console.debug(`[autobahn] skipped ${skippedNoGeometry} item(s) with no usable geometry`);
  }

  return dedupeRoadEvents(out);
}
