import type { ConditionEvent, Severity } from "@openconditions/core";
import { XMLBuilder } from "fast-xml-parser";
import { type FeedInfo, roadFields } from "./types.js";

/**
 * DATEX II v3 SituationPublication emitter — lets EU NAPs and road authorities
 * consume OpenConditions natively. Spec: https://docs.datex2.eu/ (v3 modular
 * schemas: messageContainer / situation / common / locationReferencing). No
 * usable JS DATEX II writer exists, so this hand-builds the XML with
 * fast-xml-parser, mirroring the reader in `@openconditions/roads`.
 *
 * Pragmatic deviations from a strict XSD (documented; Level-B-shaped, not
 * XSD-certified): the publication creator carries a single feed-level country
 * (the aggregate spans many); every location is reduced to a representative
 * point (precise linear/OpenLR references are Phase 2); road name/number sit
 * directly under the location reference.
 */

/** Map each canonical road type to its DATEX II v3 SituationRecord class. */
const RECORD_TYPE: Record<string, string> = {
  accident: "Accident",
  broken_down_vehicle: "VehicleObstruction",
  obstruction: "GeneralObstruction",
  hazard: "GeneralObstruction",
  security: "GeneralObstruction",
  roadworks: "MaintenanceWorks",
  congestion: "AbnormalTraffic",
  road_closure: "RoadOrCarriagewayOrLaneManagement",
  lane_closure: "RoadOrCarriagewayOrLaneManagement",
  contraflow: "RoadOrCarriagewayOrLaneManagement",
  detour: "ReroutingManagement",
  speed_restriction: "SpeedManagement",
  dimension_restriction: "SpeedManagement",
  weather: "PoorEnvironmentConditions",
  road_condition: "PoorEnvironmentConditions",
  public_event: "PublicEvent",
  authority: "AuthorityOperation",
  equipment_fault: "EquipmentOrSystemFault",
  transit_disruption: "GeneralNetworkManagement",
  other: "GeneralNetworkManagement",
};

export function toDatexRecordType(ev: ConditionEvent): string {
  return RECORD_TYPE[ev.type] ?? "GeneralNetworkManagement";
}

function toDatexSeverity(s: Severity): string {
  switch (s) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "critical":
      return "highest";
    default:
      return "unknown";
  }
}

function toValidityStatus(status: ConditionEvent["status"]): string {
  return status === "active" ? "active" : "suspended";
}

/** A DATEX management-type value (text our reader maps back to a road state). */
function managementType(ev: ConditionEvent): string | undefined {
  if (toDatexRecordType(ev) !== "RoadOrCarriagewayOrLaneManagement") return undefined;
  const rs = roadFields(ev).roadState;
  if (rs === "closed" || ev.type === "road_closure") return "roadClosed";
  if (ev.type === "contraflow" || rs === "single_lane_alternating") return "contraflow";
  return "laneClosures";
}

/** First coordinate of any geometry, as [lon, lat]. */
function representativePoint(geometry: ConditionEvent["geometry"]): [number, number] | null {
  let found: [number, number] | null = null;
  const walk = (c: unknown): void => {
    if (found || !Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      found = [c[0], c[1]];
      return;
    }
    for (const x of c) walk(x);
  };
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] };
  if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) {
    for (const sub of g.geometries) {
      if (!found) found = representativePoint(sub as ConditionEvent["geometry"]);
    }
    return found;
  }
  walk(g.coordinates);
  return found;
}

function buildLocation(ev: ConditionEvent): Record<string, unknown> {
  const road = roadFields(ev).roads?.[0];
  const pt = representativePoint(ev.geometry);
  const loc: Record<string, unknown> = { "@_xsi:type": "loc:PointLocation" };
  if (road?.name) loc["loc:roadName"] = road.name;
  if (road?.ref) loc["loc:roadNumber"] = road.ref;
  if (pt) {
    loc["loc:pointByCoordinates"] = {
      "loc:pointCoordinates": { "loc:latitude": pt[1], "loc:longitude": pt[0] },
    };
  }
  return loc;
}

function buildValidity(ev: ConditionEvent): Record<string, unknown> {
  const validity: Record<string, unknown> = {
    "com:validityStatus": toValidityStatus(ev.status),
  };
  const spec: Record<string, unknown> = {};
  if (ev.validFrom) spec["com:overallStartTime"] = ev.validFrom;
  if (ev.validTo) spec["com:overallEndTime"] = ev.validTo;
  if (Object.keys(spec).length > 0) validity["com:validityTimeSpecification"] = spec;
  return validity;
}

function buildRecord(ev: ConditionEvent): Record<string, unknown> {
  const time = ev.dataUpdatedAt ?? ev.fetchedAt;
  const rec: Record<string, unknown> = {
    "@_xsi:type": `sit:${toDatexRecordType(ev)}`,
    "@_id": ev.id,
    "@_version": "1",
    "sit:situationRecordCreationTime": time,
    "sit:situationRecordVersionTime": time,
    "sit:probabilityOfOccurrence": ev.isForecast ? "riskOf" : "certain",
    "sit:severity": toDatexSeverity(ev.severity),
    "sit:validity": buildValidity(ev),
  };
  if (ev.headline) {
    rec["sit:generalPublicComment"] = {
      "com:comment": { "com:values": { "com:value": { "@_lang": "en", "#text": ev.headline } } },
    };
  }
  const mgmt = managementType(ev);
  if (mgmt) rec["sit:roadOrCarriagewayOrLaneManagementType"] = mgmt;
  rec["sit:locationReference"] = buildLocation(ev);
  return rec;
}

function buildSituation(ev: ConditionEvent): Record<string, unknown> {
  return {
    "@_id": `sit-${ev.id}`,
    "@_version": "1",
    "sit:headerInformation": {
      "com:confidentiality": "noRestriction",
      "com:informationStatus": "real",
    },
    "sit:situationRecord": buildRecord(ev),
  };
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

/**
 * Projects condition events to a DATEX II v3 `SituationPublication`. One
 * `situation` per event (a single `situationRecord` inside). `info.timestamp`
 * sets `publicationTime`; `info.attribution` the national identifier. `country`
 * is the feed-level publication-creator country code (ISO 3166-1 α-2).
 */
export function observationsToDatexSituations(
  events: ConditionEvent[],
  info: FeedInfo = {},
  country = "other"
): string {
  const payload: Record<string, unknown> = {
    "@_xsi:type": "sit:SituationPublication",
    "@_lang": "en",
  };
  if (info.timestamp) payload["com:publicationTime"] = info.timestamp;
  payload["com:publicationCreator"] = {
    "com:country": country,
    "com:nationalIdentifier": info.attribution ?? "OpenConditions",
  };
  payload["sit:situation"] = events.map(buildSituation);

  const doc = {
    messageContainer: {
      "@_xmlns": "http://datex2.eu/schema/3/messageContainer",
      "@_xmlns:com": "http://datex2.eu/schema/3/common",
      "@_xmlns:loc": "http://datex2.eu/schema/3/locationReferencing",
      "@_xmlns:sit": "http://datex2.eu/schema/3/situation",
      "@_xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@_modelBaseVersion": "3",
      payload,
    },
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.build(doc)}`;
}
