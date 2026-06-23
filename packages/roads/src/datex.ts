import { normaliseSeverity } from "@openconditions/core";
import type { Geometry } from "geojson";
import type { RoadEvent } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
import { mapSourceType } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";
import {
  getXmlAttribute,
  getXmlChild,
  getXmlChildText,
  getXmlChildren,
  isXmlObject,
  parseXmlDocument,
  stripXmlNamespace,
  xmlNodeToArray,
  xmlText,
  type XmlObject,
} from "./xml.js";

type ValidityStatus = "active" | "inactive" | "archived" | "cancelled";

function validityStatusToStatus(raw: string | undefined): ValidityStatus {
  if (!raw) return "active";
  const lower = raw.toLowerCase();
  if (lower === "active" || lower === "definedbyvaliditytimespec") {
    return "active";
  }
  if (lower === "suspended" || lower === "inactive") return "inactive";
  if (lower === "archived") return "archived";
  if (lower === "cancelled") return "cancelled";
  return "active";
}

function elementType(rec: XmlObject): string {
  const raw = getXmlAttribute(rec, "type") ?? "";
  const colonIdx = raw.indexOf(":");
  return colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
}

function recId(rec: XmlObject): string {
  return getXmlAttribute(rec, "id") ?? `unknown-${Math.random().toString(36).slice(2)}`;
}

function text(node: unknown): string | undefined {
  return xmlText(node);
}

function multilingual(node: unknown, lang: string): string | undefined {
  if (!isXmlObject(node)) return undefined;

  const comment = getXmlChild(node, "comment") ?? node;
  const values = getXmlChild(comment, "values");

  if (values) {
    const valueNodes = xmlNodeToArray(values["value"]).filter(isXmlObject);
    const match = valueNodes.find(
      (v) => getXmlAttribute(v, "lang") === lang || getXmlAttribute(v, "lang")?.startsWith(lang)
    );
    if (match) return text(match);
    const first = valueNodes[0];
    if (first) return text(first);
  }

  return text(comment);
}

function defaultHeadline(type: string): string {
  const labels: Record<string, string> = {
    accident: "Accident",
    congestion: "Traffic congestion",
    roadworks: "Road works",
    lane_closure: "Lane closure",
    road_closure: "Road closure",
    contraflow: "Contraflow",
    detour: "Detour",
    hazard: "Road hazard",
    weather: "Weather conditions",
    road_condition: "Road condition",
    obstruction: "Obstruction",
    broken_down_vehicle: "Broken down vehicle",
    public_event: "Public event",
    authority: "Police/checkpoint",
    speed_restriction: "Speed restriction",
    dimension_restriction: "Dimension restriction",
    equipment_fault: "Equipment fault",
    security: "Security incident",
    transit_disruption: "Transit disruption",
    other: "Traffic information",
  };
  return labels[type] ?? "Traffic information";
}

/** GML `posList` / `pos` are "lat lon [lat lon ...]" under srsName "WGS 84";
 * GeoJSON wants [lon, lat]. Returns finite [lon,lat] pairs only. */
function parseLatLonList(raw: string | undefined): [number, number][] {
  if (!raw) return [];
  const nums = raw.trim().split(/\s+/).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const lat = nums[i]!;
    const lon = nums[i + 1]!;
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lon, lat]);
  }
  return out;
}

/**
 * Resolve a situationRecord's geometry by walking its location subtree for any
 * coordinate-bearing element — DATEX nests these at varying depths and shapes:
 *  - `pointByCoordinates > pointCoordinates` (latitude/longitude) → Point
 *  - GML `gmlPoint > pos` → Point; `gmlLineString > posList` → LineString
 *  - `ItineraryByIndexedLocations` → many `location`s, each with its own GML
 * Multiple lines → MultiLineString; multiple points → MultiPoint. Records with
 * no coordinate geometry (Alert-C/TMC only) return null (decoded in Phase 2).
 */
function resolveGeometry(rec: XmlObject): Geometry | null {
  const locRef = getXmlChild(rec, "locationReference") ?? getXmlChild(rec, "groupOfLocations");
  if (!locRef) return null;

  const lines: [number, number][][] = [];
  const points: [number, number][] = [];

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isXmlObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@_")) continue;
      switch (stripXmlNamespace(key)) {
        case "posList":
          for (const node of xmlNodeToArray(value)) {
            const coords = parseLatLonList(xmlText(node));
            if (coords.length >= 2) lines.push(coords);
            else if (coords.length === 1) points.push(coords[0]!);
          }
          break;
        case "pos":
          for (const node of xmlNodeToArray(value)) {
            const coords = parseLatLonList(xmlText(node));
            if (coords[0]) points.push(coords[0]);
          }
          break;
        case "pointCoordinates":
          for (const node of xmlNodeToArray(value)) {
            const lat = Number(getXmlChildText(node, "latitude"));
            const lon = Number(getXmlChildText(node, "longitude"));
            if (Number.isFinite(lat) && Number.isFinite(lon)) points.push([lon, lat]);
          }
          break;
        default:
          visit(value);
      }
    }
  };
  visit(locRef);

  if (lines.length === 1) return { type: "LineString", coordinates: lines[0]! };
  if (lines.length > 1) return { type: "MultiLineString", coordinates: lines };
  if (points.length === 1) return { type: "Point", coordinates: points[0]! };
  if (points.length > 1) return { type: "MultiPoint", coordinates: points };
  return null;
}

function directionOf(rec: XmlObject): string | undefined {
  const locRef = getXmlChild(rec, "locationReference");
  if (!locRef) return undefined;

  const pointByCoords = getXmlChild(locRef, "pointByCoordinates");
  if (pointByCoords) {
    const bearing = text(pointByCoords["bearing"]);
    if (bearing) return bearing;
  }

  const alertCDir = getXmlChild(getXmlChild(locRef, "alertCPoint"), "alertCDirection");
  return text(alertCDir?.["alertCDirectionCoded"]);
}

function roadsOf(rec: XmlObject): import("./model.js").RoadRef[] {
  const locRef = getXmlChild(rec, "locationReference");
  if (!locRef) return [];
  const pointLoc = getXmlChild(locRef, "pointLocation");

  // roadName/roadNumber may be a plain leaf or a multilingual object.
  const roadName =
    getXmlChildText(locRef, "roadName") ??
    multilingual(getXmlChild(locRef, "roadName"), "en") ??
    getXmlChildText(pointLoc, "roadName");
  const roadRef = getXmlChildText(locRef, "roadNumber") ?? getXmlChildText(pointLoc, "roadNumber");

  if (roadName || roadRef) {
    return [{ name: roadName ?? roadRef ?? "", ref: roadRef }];
  }

  return [];
}

function roadStateOf(rec: XmlObject): RoadEvent["roadState"] | undefined {
  // A leaf-text enum (e.g. "carriagewayClosures", "laneClosures", "contraflow").
  const raw = getXmlChildText(rec, "roadOrCarriagewayOrLaneManagementType")?.toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("contraflow") || raw.includes("alternat")) return "single_lane_alternating";
  if (raw.includes("carriageway") && raw.includes("clos")) return "closed";
  if (raw.includes("roadclos")) return "closed";
  if (raw.includes("lane") && raw.includes("clos")) return "some_lanes_closed";
  if (raw.includes("clos")) return "closed";
  return undefined;
}

function lanesOf(rec: XmlObject): RoadEvent["lanesAffected"] | undefined {
  // Lane counts live under <impact> in v3 (older feeds put them on the record).
  const impact = getXmlChild(rec, "impact");
  const restricted =
    getXmlChildText(impact, "numberOfLanesRestricted") ??
    getXmlChildText(rec, "numberOfLanesRestricted");
  if (restricted == null) return undefined;
  const closed = parseInt(restricted, 10);
  if (Number.isNaN(closed)) return undefined;

  const operationalRaw =
    getXmlChildText(impact, "numberOfOperationalLanes") ??
    getXmlChildText(rec, "numberOfOperationalLanes");
  const operational = operationalRaw != null ? parseInt(operationalRaw, 10) : NaN;
  const lanes: NonNullable<RoadEvent["lanesAffected"]> = { closed };
  if (!Number.isNaN(operational)) lanes.total = closed + operational;
  return lanes;
}

function collectRefs(rec: XmlObject): RoadEvent["externalRefs"] {
  const locRef = getXmlChild(rec, "locationReference");
  if (!locRef) return undefined;

  const refs: NonNullable<RoadEvent["externalRefs"]> = {};

  const alertCPoint = getXmlChild(locRef, "alertCPoint");
  if (alertCPoint) {
    const primary =
      getXmlChild(alertCPoint, "alertCMethod4PrimaryPointLocation") ??
      getXmlChild(alertCPoint, "alertCMethod2PrimaryPointLocation");
    const country = text(alertCPoint["alertCLocationCountryCode"]);
    const table = text(alertCPoint["alertCLocationTableNumber"]);
    const code = text(getXmlChild(primary, "alertCLocation")?.["specificLocation"]);
    if (country && table && code) {
      refs.tmc = {
        country,
        table: parseFloat(table),
        code: parseInt(code, 10),
      };
    }
  }

  return Object.keys(refs).length > 0 ? refs : undefined;
}

interface SituationRecord {
  rec: XmlObject;
  situationSeverity: string;
}

function listSituationRecords(doc: XmlObject): SituationRecord[] {
  const root = doc;

  let publication: XmlObject | undefined;

  const msgContainer =
    getXmlChild(root, "messageContainer") ?? getXmlChild(root, "mc:messageContainer");

  if (msgContainer) {
    publication =
      getXmlChild(msgContainer, "payload") ?? getXmlChild(msgContainer, "payloadPublication");
  }

  if (!publication) {
    const logicalModel = getXmlChild(root, "D2LogicalModel") ?? getXmlChild(root, "d2LogicalModel");

    if (logicalModel) {
      publication =
        getXmlChild(logicalModel, "payload") ?? getXmlChild(logicalModel, "payloadPublication");

      if (!publication) {
        for (const [key, value] of Object.entries(logicalModel)) {
          if (key.startsWith("@_")) continue;
          const stripped = stripXmlNamespace(key);
          if (stripped.endsWith("Publication")) {
            const candidate = xmlNodeToArray(value).find(isXmlObject);
            if (candidate) {
              publication = candidate;
              break;
            }
          }
        }
      }
    }
  }

  if (!publication) {
    for (const [key, value] of Object.entries(root)) {
      if (key.startsWith("@_")) continue;
      const stripped = stripXmlNamespace(key);
      if (
        stripped.endsWith("Publication") ||
        stripped === "payload" ||
        stripped === "payloadPublication"
      ) {
        const candidate = xmlNodeToArray(value).find(isXmlObject);
        if (candidate && ("situation" in candidate || "publicationTime" in candidate)) {
          publication = candidate;
          break;
        }
      }
    }
  }

  if (!publication) return [];

  const situations = getXmlChildren(publication, "situation");
  return situations.flatMap((sit) => {
    const sitSeverity = text(sit["overallSeverity"]) ?? "";
    return getXmlChildren(sit, "situationRecord").map((rec) => ({
      rec,
      situationSeverity: sitSeverity,
    }));
  });
}

/**
 * Parse a DATEX II SituationPublication XML document (v2 or v3) and return
 * an array of RoadEvent observations. Records without coordinate geometry
 * (Alert-C/OpenLR-only) are skipped; Phase 2 will decode those.
 */
export function parseDatexSituations(input: string | Buffer, src: SourceDescriptor): RoadEvent[] {
  const doc = parseXmlDocument(input, {
    removeNSPrefix: true,
    ignoreAttributes: false,
    isArray: (n) => n === "situation" || n === "situationRecord" || n === "value",
  });

  const records = listSituationRecords(doc);
  const out: RoadEvent[] = [];
  let skippedAlertCOnly = 0;

  for (const { rec, situationSeverity } of records) {
    const geometry = resolveGeometry(rec);
    if (!geometry) {
      skippedAlertCOnly++;
      continue;
    }

    const recType = elementType(rec);
    const { type, category, isPlanned } = mapSourceType("datex2", recType);

    const validity = getXmlChild(rec, "validity") ?? {};
    const validityStatus = text(validity["validityStatus"]);
    const timeSpec = getXmlChild(validity, "validityTimeSpecification");

    const severity =
      situationSeverity || text(rec["overallSeverity"]) || text(rec["severity"]) || "";

    const publicComment = getXmlChild(rec, "generalPublicComment");
    const fallbackComment = getXmlChild(rec, "comment");

    out.push({
      id: `${src.id}:${recId(rec)}`,
      source: src.id,
      sourceFormat: "datex2",
      domain: "roads",
      kind: "event",
      type,
      subtype: recType || undefined,
      category,
      isPlanned,
      ...normaliseSeverity(severity, { format: "datex2" }),
      status: validityStatusToStatus(validityStatus),
      geometry,
      direction: directionOf(rec),
      roads: roadsOf(rec),
      roadState: roadStateOf(rec),
      lanesAffected: lanesOf(rec),
      headline:
        multilingual(publicComment, "en") ??
        multilingual(fallbackComment, "en") ??
        defaultHeadline(type),
      description:
        multilingual(publicComment, "en") ?? multilingual(fallbackComment, "en") ?? undefined,
      validFrom: text(timeSpec?.["overallStartTime"]) ?? null,
      validTo: text(timeSpec?.["overallEndTime"]) ?? null,
      externalRefs: collectRefs(rec),
      origin: {
        kind: "feed",
        attribution: {
          provider: src.attribution,
          license: src.license,
          url: src.licenseUrl,
        },
      },
      dataUpdatedAt: text(rec["situationRecordVersionTime"]) ?? new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      isStale: false,
    });
  }

  if (skippedAlertCOnly > 0) {
    console.debug(
      `[datex] skipped ${skippedAlertCOnly} record(s) with no coordinate geometry (Alert-C/OpenLR only; Phase 2 deferred)`
    );
  }

  return dedupeRoadEvents(out);
}
