import { deriveSeverity } from "@openconditions/core";
import type { GeoJsonGeometry, RecurringWindow } from "@openconditions/core";
import type { LaneStatus, Restriction, RoadEvent, RoadRef } from "./model.js";
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

  const german = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})/);
  if (german) {
    const [, day, month, year, hour, minute] = german;
    // German-format timestamps carry no offset → interpret as Europe/Berlin.
    return berlinWallClockToISO(year!, month!, day!, hour!, minute!);
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

// The feed exposes only `startTimestamp` (ISO) structurally; the end time and
// any recurring closure windows live in localized German prose, in a few fixed
// shapes. We parse them HERE (this adapter is German-only) into the canonical
// validFrom/validTo/schedule model — never in shared code — always resolving the
// wall-clock to an absolute instant in Europe/Berlin (DST-aware). Anything
// unrecognized is left null (fail-safe → treated as ongoing/active).

const BERLIN_TZ = "Europe/Berlin";

/** Minutes Europe/Berlin is ahead of UTC at `utcMs` (60 = CET, 120 = CEST). */
function berlinOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BERLIN_TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(utcMs));
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m = tz.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/**
 * Resolve a German wall-clock to an absolute ISO instant in Europe/Berlin,
 * DST-aware. Two-digit years are 20xx. Returns null on an invalid date. Treats
 * the parts as Berlin local, then subtracts Berlin's offset at that instant —
 * so "13.07.26 05:00" (CEST) becomes 03:00Z, not 05:00Z.
 */
function berlinWallClockToISO(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string
): string | null {
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  if (![y, mo, d, h, mi].every(Number.isFinite)) return null;
  let ms = Date.UTC(y, mo - 1, d, h, mi);
  ms -= berlinOffsetMinutes(ms) * 60000;
  const dt = new Date(ms);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function pad2(s: string): string {
  return s.padStart(2, "0");
}
function localDate(year: string, month: string, day: string): string {
  return `${year.length === 2 ? `20${year}` : year}-${pad2(month)}-${pad2(day)}`;
}
function localTime(hour: string, minute: string): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

interface ParsedWindow {
  startISO: string;
  endISO: string;
  /** Local (Berlin) wall-clock parts, kept to build the recurrence schedule. */
  startDate: string; // YYYY-MM-DD
  timeStart: string; // HH:MM
  timeEnd: string; // HH:MM
}

// One recurring closure window: "29.06.26 20:00 bis zum 30.06.26 05:00 Uhr".
const WINDOW_LIST_RE =
  /(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})\s+bis\s+zum\s+(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})\s*Uhr/gi;
// Single-phase "Beginn: 10.07.26 um 22:00 Uhr" / "Ende: 13.07.26 um 05:00 Uhr".
// `Ende:` matches the phase end, NOT "Ende der Gesamtmaßnahme:" (no "um … Uhr").
const BEGIN_RE = /Beginn:\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+um\s+(\d{1,2}):(\d{2})\s*Uhr/i;
const END_RE = /Ende:\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+um\s+(\d{1,2}):(\d{2})\s*Uhr/i;

function parseWindowList(description: string): ParsedWindow[] {
  const out: ParsedWindow[] = [];
  for (const m of description.matchAll(WINDOW_LIST_RE)) {
    const [, d1, mo1, y1, h1, mi1, d2, mo2, y2, h2, mi2] = m;
    const startISO = berlinWallClockToISO(y1!, mo1!, d1!, h1!, mi1!);
    const endISO = berlinWallClockToISO(y2!, mo2!, d2!, h2!, mi2!);
    if (!startISO || !endISO) continue;
    out.push({
      startISO,
      endISO,
      startDate: localDate(y1!, mo1!, d1!),
      timeStart: localTime(h1!, mi1!),
      timeEnd: localTime(h2!, mi2!),
    });
  }
  return out;
}

/**
 * Collapse parsed windows into recurrence windows grouped by daily time-of-day
 * (local), each spanning the earliest→latest start date. The common case (one
 * nightly 20:00–05:00 band over consecutive nights) yields a single window.
 */
function windowsToSchedule(windows: ParsedWindow[]): RecurringWindow[] {
  const byTime = new Map<string, ParsedWindow[]>();
  for (const w of windows) {
    const key = `${w.timeStart}-${w.timeEnd}`;
    const group = byTime.get(key);
    if (group) group.push(w);
    else byTime.set(key, [w]);
  }
  const out: RecurringWindow[] = [];
  for (const group of byTime.values()) {
    const dates = group.map((g) => g.startDate).sort();
    out.push({
      dateStart: dates[0],
      dateEnd: dates[dates.length - 1],
      timeStart: group[0]!.timeStart,
      timeEnd: group[0]!.timeEnd,
    });
  }
  return out;
}

interface Temporal {
  validFrom: string | null;
  validTo: string | null;
  schedule?: RecurringWindow[];
}

/**
 * Derive the structured validity from an Autobahn item. `startTimestamp` (ISO)
 * is authoritative for the start. The end and any recurring windows exist only
 * as German prose: a multi-line "… bis zum … Uhr" list → `schedule` (+ outer
 * validFrom/validTo bounds), or a single "Beginn:/Ende:" pair.
 */
function extractTemporal(item: AutobahnItem, description: string | undefined): Temporal {
  const structuredStart = coerceTimestamp(item.startTimestamp);
  if (!description) return { validFrom: structuredStart, validTo: null };

  const windows = parseWindowList(description);
  if (windows.length > 0) {
    const starts = windows.map((w) => w.startISO).sort();
    const ends = windows.map((w) => w.endISO).sort();
    return {
      validFrom: structuredStart ?? starts[0]!,
      validTo: ends[ends.length - 1]!,
      schedule: windowsToSchedule(windows),
    };
  }

  const b = description.match(BEGIN_RE);
  const beginISO = b ? berlinWallClockToISO(b[3]!, b[2]!, b[1]!, b[4]!, b[5]!) : null;
  const e = description.match(END_RE);
  const endISO = e ? berlinWallClockToISO(e[3]!, e[2]!, e[1]!, e[4]!, e[5]!) : null;
  return { validFrom: structuredStart ?? beginISO, validTo: endISO };
}

/** Dimension restrictions live in the prose, e.g. "Durchfahrtsbreite: 3.25 m"
 * (width) and "Durchfahrtshöhe"/"Durchfahrtshoehe" (height, rare). Decimals may
 * use a comma or a dot. */
function restrictionsFromDescription(description: string | undefined): Restriction[] {
  if (!description) return [];
  const restrictions: Restriction[] = [];
  const dims: [string, RegExp][] = [
    ["width", /Durchfahrtsbreite:\s*([\d.,]+)\s*m/i],
    ["height", /Durchfahrtsh(?:ö|oe)he:\s*([\d.,]+)\s*m/i],
  ];
  for (const [type, re] of dims) {
    const m = description.match(re);
    if (!m?.[1]) continue;
    const value = Number(m[1].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    restrictions.push({ type, value, unit: "m" });
  }
  return restrictions;
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
      let delaySeconds: number | undefined;

      if (isFlow) {
        type = "congestion";
        category = "conditions";
        isPlanned = false;
        const delayMinutes = Number(item.delayTimeValue);
        if (Number.isFinite(delayMinutes) && delayMinutes > 0) {
          delaySeconds = delayMinutes * 60;
        }
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

      const { validFrom, validTo, schedule } = extractTemporal(item, description);
      const restrictions = restrictionsFromDescription(description);

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
        ...(delaySeconds != null ? { delaySeconds } : {}),
        ...(restrictions.length > 0 ? { restrictions } : {}),
        detour: detourFromRecommendation(item.routeRecommendation),
        isForecast: item.future === true,
        sourceRaw: item as Record<string, unknown>,
        headline,
        description,
        validFrom,
        validTo,
        ...(schedule && schedule.length > 0 ? { schedule } : {}),
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
