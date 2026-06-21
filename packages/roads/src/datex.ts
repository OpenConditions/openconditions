import { normaliseSeverity } from "@openconditions/core";
import type { Point } from "geojson";
import type { RoadEvent } from "./model.js";
import { mapSourceType } from "./taxonomy.js";
import type { SourceDescriptor } from "./types.js";
import {
  getXmlAttribute,
  getXmlChild,
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
  if (
    lower === "active" ||
    lower === "definedbyvaliditytimespec" ||
    lower === "definedByValidityTimeSpec"
  ) {
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
      (v) => getXmlAttribute(v, "lang") === lang || getXmlAttribute(v, "lang")?.startsWith(lang),
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

function resolveLocation(rec: XmlObject): Point | null {
  const locRef =
    getXmlChild(rec, "locationReference") ??
    getXmlChild(rec, "groupOfLocations");

  if (!locRef) return null;

  const pointByCoords =
    getXmlChild(locRef, "pointByCoordinates") ??
    getXmlChild(getXmlChild(locRef, "pointLocation"), "pointByCoordinates");

  if (pointByCoords) {
    const coords = getXmlChild(pointByCoords, "pointCoordinates");
    if (coords) {
      const lat = parseFloat(text(coords["latitude"]) ?? "");
      const lon = parseFloat(text(coords["longitude"]) ?? "");
      if (!isNaN(lat) && !isNaN(lon)) {
        return { type: "Point", coordinates: [lon, lat] };
      }
    }
  }

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

  const alertCDir = getXmlChild(
    getXmlChild(locRef, "alertCPoint"),
    "alertCDirection",
  );
  return text(alertCDir?.["alertCDirectionCoded"]);
}

function roadsOf(rec: XmlObject): import("./model.js").RoadRef[] {
  const locRef = getXmlChild(rec, "locationReference");
  if (!locRef) return [];

  const roadName =
    text(
      getXmlChild(locRef, "roadName") ??
        getXmlChild(getXmlChild(locRef, "pointLocation"), "roadName"),
    ) ?? undefined;
  const roadRef =
    text(
      getXmlChild(locRef, "roadNumber") ??
        getXmlChild(getXmlChild(locRef, "pointLocation"), "roadNumber"),
    ) ?? undefined;

  if (roadName || roadRef) {
    return [{ name: roadName ?? roadRef ?? "", ref: roadRef }];
  }

  return [];
}

function roadStateOf(rec: XmlObject): RoadEvent["roadState"] | undefined {
  const mgmt = getXmlChild(rec, "roadOrCarriagewayOrLaneManagementType");
  if (!mgmt) return undefined;

  const raw = text(mgmt)?.toLowerCase();
  if (raw?.includes("closed")) return "closed";
  if (raw?.includes("singlelane") || raw?.includes("alternating")) return "single_lane_alternating";
  if (raw?.includes("lane")) return "some_lanes_closed";
  return undefined;
}

function lanesOf(rec: XmlObject): RoadEvent["lanesAffected"] | undefined {
  const numberOfLanes = text(rec["numberOfLanesRestricted"]);
  if (!numberOfLanes) return undefined;
  const closed = parseInt(numberOfLanes, 10);
  return isNaN(closed) ? undefined : { closed };
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

function listSituationRecords(doc: XmlObject): XmlObject[] {
  const root = doc;

  let publication: XmlObject | undefined;

  const msgContainer =
    getXmlChild(root, "messageContainer") ??
    getXmlChild(root, "mc:messageContainer");

  if (msgContainer) {
    publication =
      getXmlChild(msgContainer, "payload") ??
      getXmlChild(msgContainer, "payloadPublication");
  }

  if (!publication) {
    const logicalModel =
      getXmlChild(root, "D2LogicalModel") ??
      getXmlChild(root, "d2LogicalModel");

    if (logicalModel) {
      publication =
        getXmlChild(logicalModel, "payload") ??
        getXmlChild(logicalModel, "payloadPublication");

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
      if (stripped.endsWith("Publication") || stripped === "payload" || stripped === "payloadPublication") {
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
  return situations.flatMap((sit) => getXmlChildren(sit, "situationRecord"));
}

/**
 * Parse a DATEX II SituationPublication XML document (v2 or v3) and return
 * an array of RoadEvent observations. Records without coordinate geometry
 * (Alert-C/OpenLR-only) are skipped; Phase 2 will decode those.
 */
export function parseDatexSituations(
  input: string | Buffer,
  src: SourceDescriptor,
): RoadEvent[] {
  const doc = parseXmlDocument(input, {
    removeNSPrefix: true,
    ignoreAttributes: false,
    isArray: (n) =>
      n === "situation" || n === "situationRecord" || n === "value",
  });

  const records = listSituationRecords(doc);
  const out: RoadEvent[] = [];
  let skippedAlertCOnly = 0;

  for (const rec of records) {
    const geometry = resolveLocation(rec);
    if (!geometry) {
      skippedAlertCOnly++;
      continue;
    }

    const recType = elementType(rec);
    const { type, category, isPlanned } = mapSourceType("datex2", recType);

    const validity = getXmlChild(rec, "validity") ?? {};
    const validityStatus = text(validity["validityStatus"]);
    const timeSpec = getXmlChild(validity, "validityTimeSpecification");

    const severity = text(rec["overallSeverity"]) ?? text(rec["severity"]) ?? "";

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
        multilingual(getXmlChild(rec, "generalPublicComment"), "en") ??
        multilingual(getXmlChild(rec, "comment"), "en") ??
        defaultHeadline(type),
      description: multilingual(getXmlChild(rec, "generalPublicComment"), "nl") ?? undefined,
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
      `[datex] skipped ${skippedAlertCOnly} record(s) with no coordinate geometry (Alert-C/OpenLR only; Phase 2 deferred)`,
    );
  }

  return out;
}
