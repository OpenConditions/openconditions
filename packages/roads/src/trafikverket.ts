import { toIsoTimestamp, validityBound } from "@openconditions/core";
import { recordSkipped } from "@openconditions/ingest-framework";
import { TRAFIKVERKET_SITUATIONS, trafikverketClassification } from "@openconditions/model-roads";
import type { Geometry, Position } from "geojson";
import { dedupeRoadEvents } from "./dedupe.js";
import type { RoadEvent, RoadEventType } from "./model.js";
import { coarseType } from "./situation/classes.js";
import type { SourceDescriptor } from "./types.js";

/**
 * Parser for Trafikverket's "Situation" object (schema 1.6, namespace
 * `road.trafficinfo`) from the open API's `data.json` endpoint. The response is
 * `{ RESPONSE: { RESULT: [ { Situation: [ { Deviation: [ … ] } ] } ] } }`; each
 * Deviation is one event. Its geometry is WKT in `Geometry.Line.WGS84`,
 * `Geometry.WGS84` or `Geometry.Point.WGS84`, lon-lat, which the schema allows
 * to be a POINT, LINESTRING, MULTILINESTRING, POLYGON or MULTIPOLYGON with an
 * optional Z. Times other than `ModifiedTime` are Swedish local time and may
 * carry no offset, so the feed names its zone. `MessageType` is one of the
 * seven documented Swedish values; a feed may leave some of them to another
 * feed with `excludeMessageTypes`.
 *
 * A deviation with no geometry is counted as such; one that is no object, has
 * no id or carries WKT that does not parse as malformed. A `MessageType` or
 * `SeverityCode` outside the documented values is counted as an unknown value.
 */

interface Deviation {
  Id?: string;
  Header?: string;
  Message?: string;
  MessageType?: string;
  MessageCode?: string;
  SeverityCode?: number;
  RoadName?: string;
  RoadNumber?: string;
  AffectedDirectionValue?: string;
  TemporaryLimit?: string;
  Suspended?: boolean;
  StartTime?: string;
  EndTime?: string;
  CreationTime?: string;
  VersionTime?: string;
  Geometry?: {
    WGS84?: string;
    Point?: { WGS84?: string };
    Line?: { WGS84?: string };
  };
}

interface Situation {
  Id?: string;
  Deleted?: boolean;
  VersionTime?: string;
  ModifiedTime?: string;
  Deviation?: Deviation[];
}

const TYPE_MAP: Record<string, RoadEventType> = {
  olycka: "accident",
  vägarbete: "roadworks",
  hinder: "obstruction",
  färjor: "transit_disruption",
};

/**
 * A `Restriktion` names its limit only in `TemporaryLimit` ("bruttovikt 8
 * ton"): a speed in km/h is a speed restriction, a weight or dimension a
 * dimension restriction, anything else stays unclassified.
 */
function restrictionType(limit: string | undefined): RoadEventType {
  if (!limit) return "other";
  if (/km\/h/i.test(limit)) return "speed_restriction";
  if (/ton\b|bruttovikt|axeltryck|boggitryck|bredd|höjd|längd/i.test(limit)) {
    return "dimension_restriction";
  }
  return "other";
}

function typeOf(rawType: string, dev: Deviation): RoadEventType {
  const lower = rawType.toLowerCase();
  if (lower === "restriktion") return restrictionType(dev.TemporaryLimit);
  return TYPE_MAP[lower] ?? "other";
}

type Nested = Position | Nested[];

/** A WKT coordinate, `x y` with an optional `z` and `m` that are dropped. */
const WKT_COORDINATE =
  /^(-?[\d.]+(?:e[-+]?\d+)?)\s+(-?[\d.]+(?:e[-+]?\d+)?)(?:\s+-?[\d.]+(?:e[-+]?\d+)?)*/i;
const WKT_GEOMETRY =
  /^\s*(POINT|LINESTRING|MULTILINESTRING|POLYGON|MULTIPOLYGON)(?:\s*(?:ZM|Z|M))?\s*(\(.*\))\s*$/is;

/** The bracketed body of a WKT geometry as nested arrays of [x, y]. */
function parseWktBody(body: string): Nested[] | null {
  let i = 0;
  const skip = () => {
    while (i < body.length && /\s/.test(body[i]!)) i++;
  };
  const coordinate = (): Position | null => {
    const m = WKT_COORDINATE.exec(body.slice(i));
    if (!m) return null;
    i += m[0].length;
    const x = Number(m[1]);
    const y = Number(m[2]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  };
  const list = (): Nested[] | null => {
    if (body[i] !== "(") return null;
    i++;
    const items: Nested[] = [];
    for (;;) {
      skip();
      const item = body[i] === "(" ? list() : coordinate();
      if (item === null) return null;
      items.push(item);
      skip();
      if (body[i] === ",") {
        i++;
        continue;
      }
      if (body[i] === ")") {
        i++;
        return items;
      }
      return null;
    }
  };
  skip();
  const out = list();
  skip();
  return out !== null && i === body.length ? out : null;
}

const isPosition = (n: Nested): n is Position => typeof n[0] === "number";
const positions = (n: Nested): Position[] | null =>
  Array.isArray(n) && n.every((c) => Array.isArray(c) && isPosition(c as Nested))
    ? (n as Position[])
    : null;
const lines = (parts: Nested[]): Position[][] | null => {
  const out = parts.map(positions);
  return out.every((p) => p !== null) ? (out as Position[][]) : null;
};

/** Parse a WGS84 WKT POINT, LINESTRING, MULTILINESTRING, POLYGON or MULTIPOLYGON. */
function wktToGeometry(wkt: string | undefined): Geometry | null {
  if (typeof wkt !== "string") return null;
  const m = WKT_GEOMETRY.exec(wkt);
  if (!m) return null;
  const body = parseWktBody(m[2]!);
  if (!body) return null;
  switch (m[1]!.toUpperCase()) {
    case "POINT": {
      const pts = positions(body);
      return pts?.length === 1 ? { type: "Point", coordinates: pts[0]! } : null;
    }
    case "LINESTRING": {
      const pts = positions(body);
      return pts && pts.length >= 2 ? { type: "LineString", coordinates: pts } : null;
    }
    case "MULTILINESTRING": {
      const parts = lines(body)?.filter((p) => p.length >= 2);
      if (!parts || parts.length === 0) return null;
      return parts.length === 1
        ? { type: "LineString", coordinates: parts[0]! }
        : { type: "MultiLineString", coordinates: parts };
    }
    case "POLYGON": {
      const rings = lines(body);
      return rings && rings.length > 0 && rings.every((r) => r.length >= 4)
        ? { type: "Polygon", coordinates: rings }
        : null;
    }
    case "MULTIPOLYGON": {
      const polygons = body.map((p) => (Array.isArray(p) && !isPosition(p) ? lines(p) : null));
      return polygons.length > 0 &&
        polygons.every((p) => p !== null && p.length > 0 && p.every((r) => r.length >= 4))
        ? { type: "MultiPolygon", coordinates: polygons as Position[][][] }
        : null;
    }
    default:
      return null;
  }
}

function severityOf(code: number | undefined): RoadEvent["severity"] {
  switch (code) {
    case 5:
      return "critical";
    case 4:
      return "high";
    case 3:
      return "medium";
    case 1:
    case 2:
      return "low";
    default:
      return "unknown";
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

export function parseTrafikverket(
  input: string | Buffer | unknown,
  src: SourceDescriptor,
): RoadEvent[] {
  let data: unknown = input;
  if (typeof input === "string" || Buffer.isBuffer(input)) {
    try {
      data = JSON.parse(input.toString("utf8"));
    } catch {
      return [];
    }
  }
  const results = (data as { RESPONSE?: { RESULT?: unknown[] } })?.RESPONSE?.RESULT;
  if (!Array.isArray(results)) return [];

  const excluded = new Set((src.excludeMessageTypes ?? []).map((t) => t.trim().toLowerCase()));
  const fetchedAt = new Date().toISOString();
  const out: RoadEvent[] = [];
  let skippedNoGeometry = 0;
  let malformed = 0;
  let unknownValues = 0;
  for (const result of results) {
    const situations = (result as { Situation?: unknown[] })?.Situation;
    if (!Array.isArray(situations)) continue;
    for (const sit of situations as Situation[]) {
      // Only a query with includedeletedobjects returns these; a withdrawn situation is no event.
      if (sit?.Deleted === true) continue;
      const deviations = sit?.Deviation;
      if (!Array.isArray(deviations)) continue;
      const sitId = text(sit.Id);
      deviations.forEach((raw: unknown, index) => {
        if (raw === null || typeof raw !== "object") {
          malformed++;
          return;
        }
        const dev = raw as Deviation;
        const rawType = text(dev.MessageType) ?? "";
        if (excluded.has(rawType.toLowerCase())) return;
        const localId = text(dev.Id) ?? (sitId ? `${sitId}:${index}` : undefined);
        if (!localId) {
          malformed++;
          return;
        }
        const wkts = [dev.Geometry?.Line?.WGS84, dev.Geometry?.WGS84, dev.Geometry?.Point?.WGS84];
        const geometry = wkts.reduce<Geometry | null>((g, wkt) => g ?? wktToGeometry(wkt), null);
        if (!geometry) {
          if (wkts.some((wkt) => text(wkt) !== undefined)) malformed++;
          else skippedNoGeometry++;
          return;
        }
        if (rawType !== "" && !Object.hasOwn(TRAFIKVERKET_SITUATIONS, rawType.toLowerCase())) {
          unknownValues++;
        }
        if (dev.SeverityCode != null && severityOf(dev.SeverityCode) === "unknown") unknownValues++;
        const { type, category, isPlanned } = coarseType(typeOf(rawType, dev));
        const classification = trafikverketClassification(rawType);
        const header = text(dev.Header);
        const message = text(dev.Message);
        const roadName = text(dev.RoadName);
        const roadNumber = text(dev.RoadNumber);
        const severity = severityOf(dev.SeverityCode);
        const updated =
          toIsoTimestamp(dev.VersionTime, src.timeZone) ??
          toIsoTimestamp(sit.VersionTime, src.timeZone) ??
          toIsoTimestamp(sit.ModifiedTime, src.timeZone);
        const suspended = dev.Suspended === true;

        out.push({
          id: `${src.id}:${localId}`,
          source: src.id,
          sourceFormat: "trafikverket",
          domain: "roads",
          kind: "event",
          situation: {
            ...(classification !== undefined ? { classification } : {}),
            ...(updated !== undefined ? { sourceUpdatedAt: updated } : {}),
            ...(header || message ? {} : { headlineFromSource: false as const }),
            ...(typeof dev.SeverityCode === "number"
              ? { severityRaw: String(dev.SeverityCode) }
              : {}),
            ...(suspended ? { validityStatus: "suspended" as const } : {}),
          },
          ...(sitId ? { situationId: sitId } : {}),
          type,
          subtype: text(dev.MessageCode) ?? (rawType || undefined),
          category,
          isPlanned,
          severity,
          severitySource: severity === "unknown" ? "derived" : "declared",
          status: suspended ? "inactive" : "active",
          geometry,
          roads:
            roadName || roadNumber
              ? [{ name: (roadName ?? roadNumber)!, ...(roadNumber ? { ref: roadNumber } : {}) }]
              : [],
          ...(dev.AffectedDirectionValue === "BothDirections" ? { direction: "both" } : {}),
          headline: header ?? message ?? text(dev.MessageCode) ?? (rawType || type),
          description: message,
          validFrom: validityBound(dev.StartTime, "start", { timeZone: src.timeZone }) ?? null,
          validTo: validityBound(dev.EndTime, "end", { timeZone: src.timeZone }) ?? null,
          sourceRaw: dev as Record<string, unknown>,
          origin: {
            kind: "feed",
            attribution: { provider: src.attribution, license: src.license, url: src.licenseUrl },
          },
          dataUpdatedAt: updated ?? toIsoTimestamp(dev.CreationTime, src.timeZone) ?? fetchedAt,
          fetchedAt,
          isStale: false,
        });
      });
    }
  }

  if (skippedNoGeometry > 0) {
    console.debug(
      `[trafikverket] ${src.id}: skipped ${skippedNoGeometry} record(s) with no usable geometry`,
    );
    recordSkipped(src.id, "no_geometry", skippedNoGeometry);
  }
  recordSkipped(src.id, "malformed", malformed);
  recordSkipped(src.id, "unknown_value", unknownValues);

  return dedupeRoadEvents(out);
}
