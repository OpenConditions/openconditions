import type { FeedPayloads, ParseContext, ParseOutput } from "@openconditions/ingest-framework";
import type { Geometry, MultiPolygon, Polygon } from "geojson";
import { capOutput } from "../cap/accounting.js";
import type { DerivedShape } from "../cap/situations.js";
import type { CapAlert, CapArea, CapInfo, CapPair } from "../cap/types.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { DERIVED_SHAPE_TOLERANCE_DEG, derivedShape, unionPolygons } from "../geometry.js";
import { isRecord } from "../records.js";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });

/** NWS writes a CAP name with several values as `{name: [values]}`; the pairs keep the values' order. */
function pairsOf(value: unknown): CapPair[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([valueName, values]) =>
    (Array.isArray(values) ? values : [values]).flatMap((v) =>
      typeof v === "string" ? [{ valueName, value: v }] : [],
    ),
  );
}

/** CAP's `sender,identifier,sent` references, space separated, from NWS's structured list. */
function referencesOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((r) => {
    if (!isRecord(r)) return [];
    const [sender, identifier, sent] = [r["sender"], r["identifier"], r["sent"]].map(text);
    return sender && identifier && sent ? [`${sender},${identifier},${sent}`] : [];
  });
  return refs.length > 0 ? refs.join(" ") : undefined;
}

/** A GeoJSON ring as a CAP polygon: `lat,lon` pairs. */
const capRing = (ring: unknown): string | undefined =>
  Array.isArray(ring)
    ? ring.map((p) => (Array.isArray(p) ? `${String(p[1])},${String(p[0])}` : "")).join(" ")
    : undefined;

/**
 * The polygons of an alert's own geometry as CAP polygons. A hole becomes an
 * `EXCLUDE_POLYGON` geocode, which the CAP mapper cuts out of the polygon it
 * lies in. Any other geometry names no area.
 */
function areaShapes(geometry: unknown): { polygon: string[]; holes: CapPair[] } {
  const polygon: string[] = [];
  const holes: CapPair[] = [];
  if (!isRecord(geometry) || !Array.isArray(geometry["coordinates"])) return { polygon, holes };
  const polygons: unknown[] =
    geometry["type"] === "Polygon"
      ? [geometry["coordinates"]]
      : geometry["type"] === "MultiPolygon"
        ? geometry["coordinates"]
        : [];
  for (const rings of polygons) {
    if (!Array.isArray(rings)) continue;
    const [outer, ...inner] = rings;
    const shell = capRing(outer);
    if (shell === undefined) continue;
    polygon.push(shell);
    for (const hole of inner) {
      const ring = capRing(hole);
      if (ring !== undefined) holes.push({ valueName: "EXCLUDE_POLYGON", value: ring });
    }
  }
  return { polygon, holes };
}

/**
 * The key of a zone from its URL: `https://api.weather.gov/zones/forecast/FLZ019`
 * → `forecast/FLZ019`. The type is part of the key because fire zones and
 * forecast zones share ids (`fire/CAZ211`, `forecast/CAZ211`).
 */
function zoneKeyOf(url: unknown): string | undefined {
  const match = typeof url === "string" ? /\/zones\/([a-z]+)\/([A-Z0-9]+)$/.exec(url) : null;
  return match === null || match === undefined ? undefined : `${match[1]}/${match[2]}`;
}

interface NwsDecoded {
  alerts: CapAlert[];
  /** The zones of an area that has no polygon of its own. */
  zonesOf: Map<CapArea, string[]>;
  /** NWS's `ends` of an alert whose hazard lasts past its CAP `expires`. */
  endsOf: Map<CapInfo, string>;
  /** Features that are no alert at all. */
  unreadable: number;
}

function decodeNws(body: Buffer): NwsDecoded {
  const root: unknown = JSON.parse(body.toString("utf8"));
  const features = isRecord(root) ? root["features"] : undefined;
  if (!Array.isArray(features)) {
    const title = isRecord(root) ? text(root["title"]) : undefined;
    throw new Error(`NWS answered no alert collection${title === undefined ? "" : `: ${title}`}`);
  }
  const alerts: CapAlert[] = [];
  const zonesOf = new Map<CapArea, string[]>();
  const endsOf = new Map<CapInfo, string>();
  let unreadable = 0;
  for (const feature of features) {
    const p = isRecord(feature) ? feature["properties"] : undefined;
    if (!isRecord(p)) {
      unreadable++;
      continue;
    }
    const { polygon, holes } = areaShapes(isRecord(feature) ? feature["geometry"] : undefined);
    const geocodes = pairsOf(p["geocode"]);
    const area: CapArea = {
      areaDesc: text(p["areaDesc"]) ?? "",
      ...(polygon.length > 0 ? { polygon } : {}),
      geocode: [...geocodes, ...holes],
    };
    if (polygon.length === 0) {
      const zones = Array.isArray(p["affectedZones"])
        ? [...new Set(p["affectedZones"].flatMap((u) => zoneKeyOf(u) ?? []))]
        : [];
      if (zones.length > 0) zonesOf.set(area, zones);
    }
    const response = text(p["response"]);
    const code = text(p["code"]);
    const info: CapInfo = {
      language: text(p["language"]) ?? "en-US",
      category: [text(p["category"]) ?? ""],
      event: text(p["event"]) ?? "",
      ...optional("responseType", response === undefined ? undefined : [response]),
      urgency: text(p["urgency"]) ?? "",
      severity: text(p["severity"]) ?? "",
      certainty: text(p["certainty"]) ?? "",
      eventCode: pairsOf(p["eventCode"]),
      parameter: pairsOf(p["parameters"]),
      area: [area],
      ...optional("effective", text(p["effective"])),
      ...optional("onset", text(p["onset"])),
      ...optional("expires", text(p["expires"])),
      ...optional("senderName", text(p["senderName"])),
      ...optional("headline", text(p["headline"])),
      ...optional("description", text(p["description"])),
      ...optional("instruction", text(p["instruction"])),
      ...optional("web", text(p["web"])),
    };
    const ends = text(p["ends"]);
    const expires = text(p["expires"]);
    if (ends !== undefined && expires !== undefined && Date.parse(ends) > Date.parse(expires)) {
      endsOf.set(info, ends);
    }
    const references = referencesOf(p["references"]);
    alerts.push({
      identifier: text(p["id"]) ?? "",
      sender: text(p["sender"]) ?? "",
      sent: text(p["sent"]) ?? "",
      status: text(p["status"]) ?? "",
      msgType: text(p["messageType"]) ?? "",
      scope: text(p["scope"]) ?? "",
      ...optional("code", code === undefined ? undefined : [code]),
      ...optional("references", references),
      info: [info],
    });
  }
  return { alerts, zonesOf, endsOf, unreadable };
}

/**
 * NWS's `/alerts/active` GeoJSON as CAP messages in the shape the CAP mapper
 * reads: NWS's one info block and one area per alert, its singular
 * `category`, `response` and `code` as one-element lists, its name→values
 * objects as ordered pairs. An alert with no geometry has its zones in the
 * area by id only; the zone shapes come from the `zones` role.
 */
export function readNwsAlerts(body: Buffer): CapAlert[] {
  return decodeNws(body).alerts;
}

/** Zone shapes by zone id, from `/zones/<type>/<id>` payloads; a payload that is no zone with a shape (a 404's problem document) adds nothing. */
function zoneShapes(bodies: readonly Buffer[]): Map<string, Polygon | MultiPolygon> {
  const shapes = new Map<string, Polygon | MultiPolygon>();
  for (const body of bodies) {
    try {
      const zone: unknown = JSON.parse(body.toString("utf8"));
      const properties = isRecord(zone) ? zone["properties"] : undefined;
      // The zone's own address names its type; a problem document has none.
      const id = zoneKeyOf(isRecord(properties) ? properties["@id"] : undefined);
      if (id === undefined || shapes.has(id)) continue;
      const shape = derivedShape(
        isRecord(zone) ? zone["geometry"] : undefined,
        DERIVED_SHAPE_TOLERANCE_DEG,
      );
      if (shape !== null) shapes.set(id, shape);
    } catch {
      // A zone that does not read leaves its alerts with their codes.
    }
  }
  return shapes;
}

/**
 * The `nws` format: the active alerts as `alert` situations. The alerts
 * payload is a complete snapshot; the cancelled and expired are gone from
 * it, and an `Update` is told from the message it replaces by its
 * references. The snapshot keeps a long-fused alert past its CAP `expires`
 * (its next expected issuance) until the hazard `ends`, and so does the
 * format; `expires` stays in the details. An alert with no geometry of its own is placed at the union of
 * the shapes of its affected zones, as far as the zones role holds them.
 * A publisher error document, which carries no alert collection, fails the
 * parse.
 */
export function parseNws(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const decoded = (payloads["alerts"] ?? []).map(decodeNws);
  const zonesOf = new Map(decoded.flatMap((d) => [...d.zonesOf]));
  const endsOf = new Map(decoded.flatMap((d) => [...d.endsOf]));
  const shapes = zoneShapes(payloads["zones"] ?? []);
  const geometryOf = (area: CapArea): DerivedShape | undefined => {
    const found = (zonesOf.get(area) ?? []).flatMap((id) => shapes.get(id) ?? []);
    const geometry: Geometry | null = unionPolygons(found);
    return geometry === null ? undefined : { geometry, origin: "derived" };
  };
  return capOutput(
    decoded.flatMap((d) => d.alerts),
    feed,
    {
      fetchedAt: ctx.fetchedAt,
      unreadable: decoded.reduce((n, d) => n + d.unreadable, 0),
      geometryOf,
      endOf: (info) => endsOf.get(info) ?? info.expires,
    },
  );
}
