import { normaliseSeverity, scheduleTimezoneForGeometry } from "@openconditions/core";
import type { Confidence } from "@openconditions/core";
import type { Geometry } from "geojson";
import type { Restriction, RoadEvent, UnresolvedRoadEvent } from "./model.js";
import { dedupeRoadEvents } from "./dedupe.js";
import { buildLocalSchedule, type LocalSchedule, withTimezone } from "./schedule.js";
import { reprojectorFor } from "./reproject.js";
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
  // xsi-typed records carry an `id` attribute; substitution-group records (e.g.
  // National Highways) carry a stable `<idG>` leaf instead.
  return (
    getXmlAttribute(rec, "id") ??
    getXmlChildText(rec, "idG") ??
    getXmlChildText(rec, "id") ??
    `unknown-${Math.random().toString(36).slice(2)}`
  );
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

type Reprojector = (p: [number, number]) => [number, number];

/**
 * GML `posList` / `pos` to `[lon,lat]` pairs (finite only). Under WGS84 the
 * values are "lat lon" → swapped to GeoJSON order, unless `lonFirst` (the feed
 * publishes "lon lat", e.g. Trafikverket) → kept as-is. When a `reproject` is
 * given (the feed's geometry is a projected grid, e.g. Flanders EPSG:31370) the
 * values are "easting northing" in CRS axis order → reprojected to [lon,lat].
 */
function parseLatLonList(
  raw: string | undefined,
  reproject?: Reprojector | null,
  lonFirst = false
): [number, number][] {
  if (!raw) return [];
  const nums = raw.trim().split(/\s+/).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const a = nums[i]!;
    const b = nums[i + 1]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push(reproject ? reproject([a, b]) : lonFirst ? [a, b] : [b, a]);
  }
  return out;
}

/** The first projected `srsName` in the document, as a reprojector to WGS84
 * (null when the feed is already WGS84). Feeds use a single CRS throughout. */
function detectReprojector(input: string | Buffer): Reprojector | null {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const matches = text.match(/srsName="([^"]+)"/g);
  if (!matches) return null;
  for (const m of matches) {
    const r = reprojectorFor(m.slice(9, -1));
    if (r) return r;
  }
  return null;
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
function resolveGeometry(
  rec: XmlObject,
  reproject?: Reprojector | null,
  lonFirst = false
): Geometry | null {
  return resolveGeometryFrom(
    getXmlChild(rec, "locationReference") ?? getXmlChild(rec, "groupOfLocations"),
    reproject,
    lonFirst
  );
}

/** Walk a location subtree (locationReference, groupOfLocations, alternativeRoute,
 * …) for any coordinate-bearing element and assemble a GeoJSON geometry. */
function resolveGeometryFrom(
  locRef: XmlObject | undefined,
  reproject?: Reprojector | null,
  lonFirst = false
): Geometry | null {
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
            const coords = parseLatLonList(xmlText(node), reproject, lonFirst);
            if (coords.length >= 2) lines.push(coords);
            else if (coords.length === 1) points.push(coords[0]!);
          }
          break;
        case "pos":
          for (const node of xmlNodeToArray(value)) {
            const coords = parseLatLonList(xmlText(node), reproject, lonFirst);
            if (coords[0]) points.push(coords[0]);
          }
          break;
        // `pointCoordinates` (DATEX v2/v3) and `coordinatesForDisplay`
        // (Trafikverket's representative point) both carry explicit
        // latitude/longitude child leaves — no axis-order ambiguity.
        case "pointCoordinates":
        case "coordinatesForDisplay":
          for (const node of xmlNodeToArray(value)) {
            const lat = Number(getXmlChildText(node, "latitude"));
            const lon = Number(getXmlChildText(node, "longitude"));
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            // Projected feeds (e.g. Flanders) carry grid easting/northing in the
            // longitude/latitude fields; reproject. WGS84 feeds pass through.
            points.push(reproject ? reproject([lon, lat]) : [lon, lat]);
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

/** The diversion route geometry from an `alternativeRoute`, when it is linear. */
function detourGeometryOf(
  rec: XmlObject,
  reproject?: Reprojector | null,
  lonFirst = false
): RoadEvent["detourGeometry"] {
  const g = resolveGeometryFrom(getXmlChild(rec, "alternativeRoute"), reproject, lonFirst);
  return g && (g.type === "LineString" || g.type === "MultiLineString") ? g : undefined;
}

/**
 * validPeriod windows → schedule: each bounded date range (startOfPeriod /
 * endOfPeriod) plus the daily time window (recurringTimePeriodOfDay) when the
 * source supplies one. The overall start/end stay on validFrom/validTo.
 */
function scheduleOf(timeSpec: XmlObject | undefined): LocalSchedule[] | undefined {
  if (!timeSpec) return undefined;
  const out: LocalSchedule[] = [];
  for (const vp of getXmlChildren(timeSpec, "validPeriod")) {
    const tod = getXmlChild(vp, "recurringTimePeriodOfDay");
    const win = buildLocalSchedule({
      startDate: getXmlChildText(vp, "startOfPeriod"),
      endDate: getXmlChildText(vp, "endOfPeriod"),
      startTime: tod ? getXmlChildText(tod, "startTimeOfPeriod") : undefined,
      endTime: tod ? getXmlChildText(tod, "endTimeOfPeriod") : undefined,
    });
    // Drop windows with neither a date range nor a time-of-day (no information).
    if (win.startDate || win.endDate || win.startTime) out.push(win);
  }
  return out.length > 0 ? out : undefined;
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
  // Lane counts live under <impact> in v3 (older feeds put them on the record);
  // the true lane total is the carriageway's originalNumberOfLanes when present.
  const impact = getXmlChild(rec, "impact");
  const restrictedRaw =
    getXmlChildText(impact, "numberOfLanesRestricted") ??
    getXmlChildText(rec, "numberOfLanesRestricted");
  const original = leafNumber(rec, "originalNumberOfLanes");
  const closed = restrictedRaw != null ? parseInt(restrictedRaw, 10) : NaN;
  if (Number.isNaN(closed) && original == null) return undefined;

  const lanes: NonNullable<RoadEvent["lanesAffected"]> = {};
  if (!Number.isNaN(closed)) lanes.closed = closed;
  if (original != null) {
    lanes.total = original;
  } else {
    const operationalRaw =
      getXmlChildText(impact, "numberOfOperationalLanes") ??
      getXmlChildText(rec, "numberOfOperationalLanes");
    const operational = operationalRaw != null ? parseInt(operationalRaw, 10) : NaN;
    if (!Number.isNaN(operational) && !Number.isNaN(closed)) lanes.total = closed + operational;
  }
  return lanes.closed != null || lanes.total != null ? lanes : undefined;
}

/**
 * The most specific source sub-classification for the record. The cause's
 * causeType wins when present (e.g. "roadMaintenance"); otherwise the record's
 * own typed discriminator is used — each DATEX situationRecord subclass carries
 * its own (accidentType, obstructionType, generalNetworkManagementType for
 * movable-bridge openings, abnormalTrafficType for congestion detail,
 * speedManagementType, …). Without this, those records fell back to the generic
 * record class name and lost their specific kind.
 */
function subtypeOf(rec: XmlObject): string | undefined {
  return (
    getXmlChildText(getXmlChild(rec, "cause"), "causeType") ??
    getXmlChildText(rec, "accidentType") ??
    getXmlChildText(rec, "obstructionType") ??
    getXmlChildText(rec, "environmentalObstructionType") ??
    getXmlChildText(rec, "vehicleObstructionType") ??
    getXmlChildText(rec, "generalNetworkManagementType") ??
    getXmlChildText(rec, "abnormalTrafficType") ??
    getXmlChildText(rec, "speedManagementType")
  );
}

/** Human cause text (DATEX `cause/causeDescription`), a multilingual block. */
function causeDescriptionOf(rec: XmlObject): string | undefined {
  return multilingual(getXmlChild(getXmlChild(rec, "cause"), "causeDescription"), "en");
}

function speedLimitOf(rec: XmlObject): number | undefined {
  const raw = getXmlChildText(rec, "temporarySpeedLimit");
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function detourOf(rec: XmlObject): string | undefined {
  const node = getXmlChild(rec, "reroutingItineraryDescription");
  return (
    multilingual(node, "en") ??
    getXmlChildText(rec, "reroutingItineraryDescription") ??
    getXmlChildText(rec, "reroutingManagementType")
  );
}

function relatedRefsOf(rec: XmlObject): string[] | undefined {
  const ref = getXmlChildText(rec, "situationRecordCreationReference");
  return ref ? [ref] : undefined;
}

function confidenceOf(rec: XmlObject): Confidence | undefined {
  switch (getXmlChildText(rec, "probabilityOfOccurrence")?.toLowerCase()) {
    case "certain":
      return "observed";
    case "probable":
      return "likely";
    case "riskof":
      return "possible";
    case "improbable":
      return "unknown";
    default:
      return undefined;
  }
}

/** First descendant element (anywhere in the subtree) with the given local name. */
function findFirst(node: unknown, localName: string): XmlObject | undefined {
  if (Array.isArray(node)) {
    for (const x of node) {
      const f = findFirst(x, localName);
      if (f) return f;
    }
    return undefined;
  }
  if (!isXmlObject(node)) return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (stripXmlNamespace(key) === localName && isXmlObject(value)) return value;
    const f = findFirst(value, localName);
    if (f) return f;
  }
  return undefined;
}

/** All leaf text values (anywhere in the subtree) of elements with the given local name. */
function collectLeaf(node: unknown, localName: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const x of node) collectLeaf(x, localName, out);
    return out;
  }
  if (!isXmlObject(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    if (stripXmlNamespace(key) === localName) {
      const t = xmlText(value);
      if (t) out.push(t);
    }
    collectLeaf(value, localName, out);
  }
  return out;
}

function vehiclesAffectedOf(rec: XmlObject): string[] | undefined {
  const set = new Set([...collectLeaf(rec, "vehicleType"), ...collectLeaf(rec, "vehicleUsage")]);
  return set.size > 0 ? [...set] : undefined;
}

/** Dimension/weight restrictions (vehicleHeight/Width/Length, gross weight). */
function dimensionRestrictionsOf(rec: XmlObject): Restriction[] | undefined {
  const out: Restriction[] = [];
  const dim = (name: string, type: string, unit: string) => {
    const raw = collectLeaf(rec, name)[0];
    const n = raw != null ? Number(raw) : NaN;
    if (Number.isFinite(n)) out.push({ type, value: n, unit });
  };
  dim("vehicleHeight", "height", "m");
  dim("vehicleWidth", "width", "m");
  dim("vehicleLength", "length", "m");
  dim("grossVehicleWeight", "weight", "kg");
  return out.length > 0 ? out : undefined;
}

function leafNumber(rec: XmlObject, name: string): number | undefined {
  const raw = collectLeaf(rec, name)[0];
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Extracts an OpenLR base64 string from the record's locationReference, if
 * present. Tries several common element names used by DATEX II v2 and v3.
 */
function collectOpenLr(rec: XmlObject): string | undefined {
  const locRef = getXmlChild(rec, "locationReference");

  if (locRef) {
    const candidates = ["openlrBinary", "base64", "openLRBinary"];
    for (const name of candidates) {
      const val = getXmlChildText(locRef, name);
      if (val) return val;
    }
  }

  return getXmlChildText(rec, "openlrBinary") ?? undefined;
}

/** Alert-C/TMC reference (country + table + primary specific-location code). */
function tmcOf(rec: XmlObject): NonNullable<RoadEvent["externalRefs"]>["tmc"] | undefined {
  const locRef = getXmlChild(rec, "locationReference");
  if (!locRef) return undefined;

  // alertCPoint (point location) or, nested in an itinerary, alertCLinear.
  const alertC = findFirst(locRef, "alertCPoint") ?? findFirst(locRef, "alertCLinear");
  if (!alertC) return undefined;

  const primary =
    findFirst(alertC, "alertCMethod4PrimaryPointLocation") ??
    findFirst(alertC, "alertCMethod2PrimaryPointLocation");
  const country = getXmlChildText(alertC, "alertCLocationCountryCode");
  const table = getXmlChildText(alertC, "alertCLocationTableNumber");
  const code = getXmlChildText(getXmlChild(primary, "alertCLocation"), "specificLocation");
  if (country && table && code) {
    return { country, table: parseFloat(table), code: parseInt(code, 10) };
  }
  return undefined;
}

/** Provider external location code (NDW's `externalReferencing`, e.g. RIS-index). */
function externalLocationOf(rec: XmlObject): { system: string; code: string } | undefined {
  const er = getXmlChild(getXmlChild(rec, "locationReference"), "externalReferencing");
  const system = getXmlChildText(er, "externalReferencingSystem");
  const code = getXmlChildText(er, "externalLocationCode");
  return system && code ? { system, code } : undefined;
}

function externalRefsOf(rec: XmlObject): RoadEvent["externalRefs"] {
  const tmc = tmcOf(rec);
  const external = externalLocationOf(rec);
  if (!tmc && !external) return undefined;
  return { ...(tmc ? { tmc } : {}), ...(external ? { external } : {}) };
}

interface SituationRecord {
  rec: XmlObject;
  situationSeverity: string;
}

function listSituationRecords(doc: XmlObject): SituationRecord[] {
  let root = doc;

  // Some national access points (e.g. France DIR / Bison Futé) wrap the DATEX
  // document in a SOAP envelope. Unwrap it (namespace prefixes are already
  // stripped) so the publication lookup below sees the d2LogicalModel directly.
  const envelope = getXmlChild(root, "Envelope");
  if (envelope) {
    const body = getXmlChild(envelope, "Body");
    if (body) root = body;
  }

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

  // National Highways (England) and similar emit the publication AS the document
  // root (e.g. <D2Payload> carrying <feedType>SituationPublication</feedType>)
  // with <situation> children directly inside it — no nested payload /
  // ...Publication wrapper for the loops above to match. As a last resort, accept
  // any root child object that directly holds situations.
  if (!publication) {
    for (const [key, value] of Object.entries(root)) {
      if (key.startsWith("@_")) continue;
      const candidate = xmlNodeToArray(value).find(isXmlObject);
      if (candidate && "situation" in candidate) {
        publication = candidate;
        break;
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

/** Field names that mark a node as the situationRecord body (not a wrapper). */
const RECORD_BODY_MARKERS = [
  "situationRecordVersionTime",
  "situationRecordCreationTime",
  "locationReference",
  "validity",
];

/**
 * Resolve the effective record body and its class name. Most DATEX feeds put the
 * fields directly on `<situationRecord xsi:type="…">`. Others (e.g. National
 * Highways) use the v3 substitution group: `<situationRecord><sit{Class}>…fields,
 * locationReference…</sit{Class}></situationRecord>` with NO xsi:type. There the
 * real body — and the only locationReference the geometry walk can reach — is one
 * level down, and the wrapper element name carries the record class. Descend into
 * that wrapper so the field/geometry getters see the body, and surface the class
 * name (`sitRoadOrCarriagewayOrLaneManagement` → `RoadOrCarriagewayOrLaneManagement`).
 */
function recordBody(rawRec: XmlObject): { body: XmlObject; className?: string } {
  if (RECORD_BODY_MARKERS.some((m) => m in rawRec)) return { body: rawRec };
  for (const [key, value] of Object.entries(rawRec)) {
    if (key.startsWith("@_")) continue;
    const child = xmlNodeToArray(value).find(isXmlObject);
    if (child && RECORD_BODY_MARKERS.some((m) => m in child)) {
      const stripped = stripXmlNamespace(key);
      const className = stripped.startsWith("sit") ? stripped.slice(3) : stripped;
      return { body: child, className };
    }
  }
  return { body: rawRec };
}

/**
 * Parse a DATEX II SituationPublication XML document (v2 or v3) and return
 * an array of RoadEvent or UnresolvedRoadEvent observations.
 *
 * Records with coordinate geometry are returned as RoadEvent (geometry
 * present). Records with an OpenLR binary location but no coordinate geometry
 * are returned as UnresolvedRoadEvent (geometry absent, externalRefs.openlr
 * set); the ingest resolve stage will either fill geometry or drop them.
 * Records with neither geometry nor OpenLR are skipped entirely.
 *
 * Unresolved markers bypass deduplication (which requires coordinate geometry)
 * and are appended after the deduped set.
 */
export function parseDatexSituations(
  input: string | Buffer,
  src: SourceDescriptor
): (RoadEvent | UnresolvedRoadEvent)[] {
  const doc = parseXmlDocument(input, {
    removeNSPrefix: true,
    ignoreAttributes: false,
    isArray: (n) => n === "situation" || n === "situationRecord" || n === "value",
  });

  // Feeds whose GML geometry is a projected national grid (e.g. Flanders
  // EPSG:31370) declare it via srsName; reproject those to WGS84.
  const reproject = detectReprojector(input);
  // Some publishers emit GML posList in "lon lat" order (e.g. Trafikverket),
  // opposite the DATEX/WGS84 "lat lon" default.
  const lonFirst = src.posListLonLat ?? false;

  const records = listSituationRecords(doc);
  const withGeom: RoadEvent[] = [];
  const unresolved: UnresolvedRoadEvent[] = [];
  let skippedAlertCOnly = 0;

  for (const { rec: rawRec, situationSeverity } of records) {
    const { body: rec, className } = recordBody(rawRec);
    const geometry = resolveGeometry(rec, reproject, lonFirst);
    const openlr = !geometry ? collectOpenLr(rec) : undefined;

    if (!geometry && !openlr) {
      skippedAlertCOnly++;
      continue;
    }

    const recType = elementType(rec) || className || "";
    const { type, category, isPlanned } = mapSourceType("datex2", recType);

    const validity = getXmlChild(rec, "validity") ?? {};
    const validityStatus = text(validity["validityStatus"]);
    const timeSpec = getXmlChild(validity, "validityTimeSpecification");

    const severity =
      situationSeverity || text(rec["overallSeverity"]) || text(rec["severity"]) || "";
    const normalised = normaliseSeverity(severity, { format: "datex2" });
    // A safety-related message with no declared severity is at least medium.
    const safetyRelated = getXmlChildText(rec, "safetyRelatedMessage") === "true";
    const severityFields =
      normalised.severity === "unknown" && safetyRelated
        ? { severity: "medium" as const, severitySource: "derived" as const }
        : normalised;

    const publicComment = getXmlChild(rec, "generalPublicComment");
    const fallbackComment = getXmlChild(rec, "comment");
    const causeDesc = causeDescriptionOf(rec);

    const shared = {
      id: `${src.id}:${recId(rec)}`,
      source: src.id,
      sourceFormat: "datex2" as const,
      domain: "roads" as const,
      kind: "event" as const,
      type,
      subtype: subtypeOf(rec) ?? recType ?? undefined,
      category,
      isPlanned,
      ...severityFields,
      confidence: confidenceOf(rec),
      status: validityStatusToStatus(validityStatus),
      direction: directionOf(rec),
      roads: roadsOf(rec),
      roadState: roadStateOf(rec),
      lanesAffected: lanesOf(rec),
      speedLimitKph: speedLimitOf(rec),
      restrictions: dimensionRestrictionsOf(rec),
      vehiclesAffected: vehiclesAffectedOf(rec),
      detour: detourOf(rec),
      detourGeometry: detourGeometryOf(rec, reproject, lonFirst),
      delaySeconds: leafNumber(rec, "delayTimeValue"),
      queueLengthMeters: leafNumber(rec, "queueLength"),
      relatedIds: relatedRefsOf(rec),
      sourceRaw: rec,
      headline:
        multilingual(publicComment, "en") ??
        multilingual(fallbackComment, "en") ??
        causeDesc ??
        defaultHeadline(type),
      description:
        multilingual(publicComment, "en") ??
        multilingual(fallbackComment, "en") ??
        causeDesc ??
        undefined,
      validFrom: text(timeSpec?.["overallStartTime"]) ?? null,
      validTo: text(timeSpec?.["overallEndTime"]) ?? null,
      origin: {
        kind: "feed" as const,
        attribution: {
          provider: src.attribution,
          license: src.license,
          url: src.licenseUrl,
        },
      },
      dataUpdatedAt: text(rec["situationRecordVersionTime"]) ?? new Date().toISOString(),
      fetchedAt: new Date().toISOString(),
      isStale: false,
    };

    if (geometry) {
      withGeom.push({
        ...shared,
        geometry,
        // Local schedule times are stamped with the zone of the closure's
        // location (resolved from geometry), so the recurrence is unambiguous.
        schedule: withTimezone(scheduleOf(timeSpec), scheduleTimezoneForGeometry(geometry)),
        externalRefs: externalRefsOf(rec),
      });
    } else {
      // openlr is defined here because we checked !geometry && !openlr above.
      unresolved.push({
        ...shared,
        geometry: undefined,
        externalRefs: { ...externalRefsOf(rec), openlr: openlr! },
      });
    }
  }

  if (skippedAlertCOnly > 0) {
    console.debug(
      `[datex] skipped ${skippedAlertCOnly} record(s) with no coordinate geometry (Alert-C only)`
    );
  }

  // Unresolved OpenLR markers (no geometry yet) must bypass dedupe, which
  // requires a coordinate to compute merge distance. They are appended after
  // the deduped set and resolved to geometry by the ingest resolve stage.
  return [...dedupeRoadEvents(withGeom), ...unresolved];
}
