import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { capPolygon } from "@openconditions/model-hazards";
import { XMLParser } from "fast-xml-parser";
import type { Geometry } from "geojson";
import { accountSituations } from "../accounting.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { pointGeometry } from "../geometry.js";
import { freshness, isRecord, provenance, situationId, utcInstant } from "../records.js";

/** The GDACS event types this format takes, as the hazard type they become. */
const TYPES: Readonly<Record<string, string>> = {
  TC: "tropical_cyclone",
  FL: "flood",
  VO: "volcano",
  DR: "drought",
};

/** GDACS's alert colours as the severity they declare. */
const ALERTS: Readonly<Record<string, string>> = {
  green: "minor",
  orange: "major",
  red: "critical",
};

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (tag) => tag === "item" || tag === "info" || tag === "area" || tag === "polygon",
});

/** The root of a GDACS RSS document, which fails the parse when it is anything else. */
function channelOf(body: Buffer, role: string): Record<string, unknown> {
  const raw = body.toString("utf8");
  if (/<!ENTITY/i.test(raw)) throw new Error("GDACS: XML entity declarations are not allowed");
  const doc: unknown = parser.parse(raw);
  const rss = isRecord(doc) ? doc["rss"] : undefined;
  const channel = isRecord(rss) ? rss["channel"] : undefined;
  if (!isRecord(channel)) throw new Error(`GDACS answered no RSS channel for ${role}`);
  return channel;
}

const itemsOf = (channel: Record<string, unknown>): Record<string, unknown>[] =>
  Array.isArray(channel["item"]) ? channel["item"].filter(isRecord) : [];

/** The text of an element, whether it carries attributes or not. */
function str(value: unknown): string | undefined {
  const raw = isRecord(value) ? value["#text"] : value;
  const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  return s === "" ? undefined : s;
}

/** An attribute of an element. */
function attribute(value: unknown, name: string): string | undefined {
  return isRecord(value) ? str(value[`@_${name}`]) : undefined;
}

const ZONED = /(?:GMT|UTC|Z|[+-]\d{2}:?\d{2})$/;
const NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/** A GDACS time: RFC 822 with GMT in the feeds, ISO without a zone elsewhere, which is UTC. */
function gdacsTime(value: unknown): string | undefined {
  const s = str(value);
  if (s === undefined) return undefined;
  const at = new Date(ZONED.test(s) ? s : NAIVE.test(s) ? `${s}Z` : Number.NaN);
  return Number.isNaN(at.getTime()) ? undefined : utcInstant(at);
}

/** The event's own point, from the W3C geo element or the GeoRSS one (`lat lon`). */
function rssPoint(item: Record<string, unknown>): Geometry | null {
  const geo = item["Point"];
  if (isRecord(geo)) {
    const point = pointGeometry({
      type: "Point",
      coordinates: [Number(str(geo["long"])), Number(str(geo["lat"]))],
    });
    if (point !== null) return point;
  }
  const [lat, lon] = (str(item["point"]) ?? "").split(/\s+/).map(Number);
  return pointGeometry({ type: "Point", coordinates: [lon, lat] });
}

/**
 * A cyclone's subtype from GDACS's severity text, and where it is: a
 * hurricane in the Atlantic and eastern Pacific (west of Greenwich), a
 * typhoon in the northwest Pacific, a cyclone in the Indian Ocean and the
 * southern hemisphere.
 */
function cycloneSubtype(label: string | undefined, point: Geometry): string | undefined {
  const t = (label ?? "").toLowerCase();
  if (t.startsWith("tropical depression")) return "tropical_depression";
  if (t.startsWith("tropical storm")) return "tropical_storm";
  if (!/^(hurricane|typhoon)/.test(t) || point.type !== "Point") return undefined;
  const [lon, lat] = point.coordinates as [number, number];
  if (lat >= 0 && lon < 0) return "hurricane";
  if (lat >= 0 && lon >= 100) return "typhoon";
  return "cyclone";
}

/** The CAP alerts of the `areas` role by identifier, each as the exterior rings of its polygons. */
function areasOf(payloads: readonly Buffer[]): Map<string, [number, number][][][]> {
  const areas = new Map<string, [number, number][][][]>();
  for (const body of payloads) {
    for (const item of itemsOf(channelOf(body, "areas"))) {
      const alert = item["alert"];
      const identifier = isRecord(alert) ? str(alert["identifier"]) : undefined;
      if (!isRecord(alert) || identifier === undefined) continue;
      const polygons = (Array.isArray(alert["info"]) ? alert["info"] : [])
        .filter(isRecord)
        .flatMap((info) => (Array.isArray(info["area"]) ? info["area"] : []).filter(isRecord))
        .flatMap((area) => (Array.isArray(area["polygon"]) ? area["polygon"] : []))
        .flatMap((polygon) => {
          const rings = capPolygon(str(polygon) ?? "");
          return rings === null ? [] : rings.map((ring) => [ring as [number, number][]]);
        });
      areas.set(identifier, polygons);
    }
  }
  return areas;
}

function toDraft(
  item: Record<string, unknown>,
  eventType: string,
  localId: string,
  geometry: Geometry,
  feed: HazardsCatalogFeed,
  fetchedAt: string,
): RecordDraft | null {
  const start = gdacsTime(item["fromdate"]);
  if (start === undefined) return null;
  const type = TYPES[eventType]!;
  const current = str(item["iscurrent"])?.toLowerCase() !== "false";
  const end = gdacsTime(item["todate"]);
  const alert = str(item["alertlevel"]);
  const label = alert === undefined ? undefined : ALERTS[alert.toLowerCase()];
  const score = Number(str(item["alertscore"]));
  const level = score === 1 || score === 2 || score === 3 ? score : undefined;
  const title = str(item["title"]);
  const description = str(item["description"]);
  const name = str(item["eventname"]);
  const link = str(item["link"]);
  const glide = str(item["glide"]);
  const severityText = str(item["severity"]);
  const wind = Number(attribute(item["severity"], "value"));
  const windUnit = attribute(item["severity"], "unit");
  const population = Number(attribute(item["population"], "value"));
  const updated = gdacsTime(item["datemodified"]);
  const subtype =
    eventType === "TC" ? cycloneSubtype(severityText, rssPoint(item) ?? geometry) : undefined;
  return {
    id: situationId(feed, localId),
    class: "situation",
    kind: "natural_hazard",
    type,
    ...(subtype === undefined ? {} : { subtype }),
    temporality: "live",
    externalIds: [
      { scheme: "gdacs:event", id: localId },
      ...(glide === undefined ? [] : [{ scheme: "glide", id: glide }]),
    ],
    location: {
      geometry,
      extent: geometry.type === "Point" ? "point" : "area",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
    provenance: provenance(feed, localId, updated),
    freshness: freshness(fetchedAt),
    planned: false,
    certainty: "observed",
    severity:
      label === undefined
        ? { label: "unknown" }
        : {
            label,
            source: "declared",
            declaredRaw: alert,
            ...(level === undefined ? {} : { level }),
          },
    ...(title === undefined ? {} : { headline: [{ lang: "en", text: title }] }),
    ...(description === undefined ? {} : { description: [{ lang: "en", text: description }] }),
    validity: current
      ? { status: "active", start }
      : {
          status: "ended",
          start,
          ...(end === undefined ? {} : { end: end < start ? start : end }),
        },
    effects: [],
    details: {
      kind: "natural_hazard",
      v: 1,
      ...(name === undefined ? {} : { name: [{ lang: "en", text: name }] }),
      ...(link !== undefined && /^https?:\/\//.test(link) ? { detailUrl: link } : {}),
      ...(eventType === "TC" && windUnit === "km/h" && Number.isFinite(wind) && wind >= 0
        ? { maxWind: { value: Math.round(wind), unit: "km/h" } }
        : {}),
      ...(Number.isInteger(population) && population >= 0
        ? { populationAffected: population }
        : {}),
    },
  };
}

/**
 * The `gdacs` format: the Global Disaster Alert and Coordination System's
 * current events (tropical cyclones, floods, volcanoes, droughts) as
 * `natural_hazard` situations, read from the `events` RSS. Earthquakes and
 * wildfires are terminal: USGS, NIFC, EFFIS and FIRMS report them first-hand.
 *
 * The local id is the RSS `guid` (`<type><eventid>`), also the `gdacs:event`
 * external id, with the GLIDE number when GDACS has one. GDACS alerts are
 * `Green`, `Orange` or `Red` with a 1..3 score. An event with
 * `iscurrent=false` has ended at its `todate`. The optional `areas` role is
 * GDACS's CAP feed: the areas of an event's current episode
 * (`GDACS_<type>_<eventid>_<episode>`) become a MultiPolygon (a cyclone's
 * wind buffer, a flood's affected area), else the event keeps its RSS point.
 * A cyclone's subtype comes from GDACS's severity text and its basin; its
 * wind is the severity value in km/h. An item with no usable id, time or
 * position is rejected and counted; a document with no RSS channel fails the
 * parse.
 */
export function parseGdacs(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const areas = areasOf(payloads["areas"] ?? []);
  const seen = new Set<string>();
  let inputCount = 0;
  let duplicates = 0;
  let rejected = 0;
  let terminal = 0;
  for (const body of payloads["events"] ?? []) {
    for (const item of itemsOf(channelOf(body, "events"))) {
      inputCount++;
      const eventType = str(item["eventtype"]);
      const eventId = str(item["eventid"]);
      if (eventType === undefined || eventId === undefined || !/^\d+$/.test(eventId)) {
        rejected++;
        continue;
      }
      const localId = `${eventType}${eventId}`;
      if (seen.has(localId)) {
        duplicates++;
        continue;
      }
      seen.add(localId);
      if (TYPES[eventType] === undefined) {
        terminal++;
        continue;
      }
      const rings =
        areas.get(`GDACS_${eventType}_${eventId}_${str(item["episodeid"]) ?? ""}`) ?? [];
      const geometry: Geometry | null =
        rings.length > 0 ? { type: "MultiPolygon", coordinates: rings } : rssPoint(item);
      const draft =
        geometry === null ? null : toDraft(item, eventType, localId, geometry, feed, ctx.fetchedAt);
      if (draft === null) rejected++;
      else out.situations.push(draft);
    }
  }

  accountSituations(out, { inputCount, duplicates, rejected, terminal });
  return out;
}
