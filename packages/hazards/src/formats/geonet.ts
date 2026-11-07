import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { accountSituations } from "../accounting.js";
import type { HazardsCatalogFeed } from "../feed-schema.js";
import { pointGeometry } from "../geometry.js";
import { freshness, isRecord, pointLocation, provenance, situationId } from "../records.js";

export const GEONET_ID = /^(?:\d{5,7}|\d{4}p\d{6})$/;
export const GEONET_ACCEPT = "application/vnd.geo+json;version=2";
export const GEONET_COVERAGE_MS = 72 * 3600_000;
type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec => (isRecord(v) ? v : {});
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const xmlNum = (v: unknown): number | undefined =>
  typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;
export const geonetInstant = (v: unknown): string | undefined =>
  typeof v === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(v) && Number.isFinite(Date.parse(v))
    ? v
    : undefined;

export interface GeonetSolution {
  id: string;
  type: string;
  time: string;
  point: [number, number];
  depth?: number;
  magnitude?: { value: number; scale: string };
  reviewed?: boolean;
}

/** Exact event and preferred references only; other origins/magnitudes cannot fill a missing preference. */
export function geonetSolutions(body: Buffer): GeonetSolution[] {
  const xml = body.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("Invalid GeoNet QuakeML");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
  }).parse(xml);
  const root = obj(obj(parsed)["quakeml"]);
  const parameters = obj(root["eventParameters"]);
  if (!Object.keys(parameters).length) throw new Error("Missing QuakeML eventParameters");
  return list(parameters["event"]).map((raw) => {
    const e = obj(raw);
    const publicId = str(e["@_publicID"]);
    const id = publicId?.match(/^smi:nz\.org\.geonet\/(\d{5,7}|\d{4}p\d{6})$/)?.[1];
    const origins = list(e["origin"])
      .map(obj)
      .filter((o) => o["@_publicID"] === e["preferredOriginID"]);
    const magnitudes = list(e["magnitude"])
      .map(obj)
      .filter((m) => m["@_publicID"] === e["preferredMagnitudeID"]);
    if (!id || origins.length !== 1 || magnitudes.length > 1)
      throw new Error("Ambiguous GeoNet preferred solution");
    const o = origins[0]!;
    const time = geonetInstant(obj(o["time"])["value"]);
    const lon = xmlNum(obj(o["longitude"])["value"]);
    const lat = xmlNum(obj(o["latitude"])["value"]);
    const type = str(e["type"]);
    if (
      !time ||
      lon === undefined ||
      lat === undefined ||
      Math.abs(lon) > 180 ||
      Math.abs(lat) > 90 ||
      !type
    )
      throw new Error("Malformed GeoNet origin");
    const m = magnitudes[0];
    const value = xmlNum(obj(m?.["mag"])["value"]);
    const scale = str(m?.["type"]);
    const depth = xmlNum(obj(o["depth"])["value"]);
    return {
      id,
      type,
      time,
      point: [lon, lat],
      ...(depth === undefined ? {} : { depth }),
      ...(value === undefined || scale === undefined ? {} : { magnitude: { value, scale } }),
      ...(o["evaluationMode"] === "manual" ? { reviewed: true } : {}),
    };
  });
}

export function geonetFeatures(body: Buffer): Rec[] {
  const root = obj(JSON.parse(body.toString("utf8")));
  if (root["type"] !== "FeatureCollection" || !Array.isArray(root["features"]))
    throw new Error("Invalid GeoNet collection");
  return root["features"].map((raw) => {
    if (
      !isRecord(raw) ||
      !isRecord(raw["properties"]) ||
      !GEONET_ID.test(String(raw["properties"]["publicID"]))
    )
      throw new Error("Invalid GeoNet identity");
    return raw;
  });
}

/** History order is unspecified. Undated detail is the current fallback, never a fabricated update clock. */
export function geonetRevision(detail: Rec, history: readonly Rec[], fetchedAt: string): Rec {
  const id = obj(detail["properties"])["publicID"];
  const applicable = [detail, ...history].filter(
    (f) =>
      obj(f["properties"])["publicID"] === id &&
      geonetInstant(obj(f["properties"])["modificationTime"]) !== undefined &&
      Date.parse(String(obj(f["properties"])["modificationTime"])) <= Date.parse(fetchedAt),
  );
  return applicable.reduce(
    (a, b) =>
      Date.parse(String(obj(b["properties"])["modificationTime"])) >
      Date.parse(String(obj(a["properties"])["modificationTime"]))
        ? b
        : a,
    applicable[0] ?? detail,
  );
}

export function geonetDraft(
  feed: HazardsCatalogFeed,
  feature: Rec,
  solution: GeonetSolution | undefined,
  fetchedAt: string,
): RecordDraft | null {
  const p = obj(feature["properties"]);
  const id = String(p["publicID"]);
  const quality = str(p["quality"]);
  if (
    !GEONET_ID.test(id) ||
    !quality ||
    !["best", "automatic", "preliminary", "deleted"].includes(quality)
  )
    throw new Error("Unknown GeoNet quality/identity");
  if (solution && solution.id !== id) throw new Error("GeoNet enrichment identity mismatch");
  if (quality === "deleted" || (solution && solution.type !== "earthquake")) return null;
  const geometry = pointGeometry(feature["geometry"]);
  const apiTime = geonetInstant(p["time"]);
  if (!geometry || !apiTime) throw new Error("Invalid GeoNet geometry/time");
  const time = solution?.time ?? apiTime;
  const update = geonetInstant(p["modificationTime"]);
  const locality = str(p["locality"]);
  const mmi = num(p["mmi"]);
  const apiDepth = num(p["depth"]);
  const depth = solution?.depth ?? (apiDepth === undefined ? undefined : apiDepth * 1000);
  if (depth !== undefined && !Number.isFinite(depth)) throw new Error("Invalid GeoNet depth");
  return {
    id: situationId(feed, id),
    class: "situation",
    kind: "natural_hazard",
    type: "earthquake",
    temporality: "live",
    externalIds: [{ scheme: "geonet:event", id }],
    location: pointLocation(solution?.point ?? (geometry.coordinates as [number, number])),
    provenance: provenance(feed, id, update),
    freshness: freshness(fetchedAt, new Date(Date.parse(time) + GEONET_COVERAGE_MS).toISOString()),
    planned: false,
    certainty: "observed",
    severity: { label: "unknown" },
    validity: { status: "ended", start: time, end: time },
    effects: [],
    details: {
      kind: "natural_hazard",
      v: 1,
      detailUrl: `https://www.geonet.org.nz/earthquake/${id}`,
      ...(locality ? { name: [{ lang: "en", text: locality }] } : {}),
      ...(depth === undefined ? {} : { depth: { value: depth, unit: "m" } }),
      ...(solution?.magnitude ? { magnitude: solution.magnitude } : {}),
      ...(solution?.reviewed === undefined ? {} : { reviewed: solution.reviewed }),
    },
    extras: {
      geonetQuality: quality,
      ...(locality ? { geonetLocality: locality } : {}),
      ...(mmi !== undefined && mmi >= 0 && mmi <= 12 ? { geonetLocalityMmi: mmi } : {}),
    },
  };
}

/** Pure parser for acquired detail/history/QuakeML. The capped discovery list alone is never a snapshot. */
export function parseGeonet(
  feed: HazardsCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  if (!payloads["detail"])
    throw new Error("GeoNet requires reconciled acquisition, not recent-list publication");
  const solutions = new Map(
    (payloads["solutions"] ?? []).flatMap(geonetSolutions).map((s) => [s.id, s]),
  );
  const history = (payloads["history"] ?? []).flatMap(geonetFeatures);
  const out = emptyParseOutput();
  const details = (payloads["detail"] ?? []).flatMap(geonetFeatures);
  for (const feature of details) {
    const f = geonetRevision(feature, history, ctx.fetchedAt);
    const id = String(obj(f["properties"])["publicID"]);
    const draft = geonetDraft(feed, f, solutions.get(id), ctx.fetchedAt);
    if (draft) out.situations.push(draft);
  }
  accountSituations(out, {
    inputCount: details.length,
    duplicates: 0,
    rejected: 0,
    terminal: details.length - out.situations.length,
  });
  return out;
}
