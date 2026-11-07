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
const num = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("Invalid GeoNet number");
  return v;
};
const xmlNum = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  if (
    typeof v !== "string" ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim()) ||
    !Number.isFinite(Number(v))
  )
    throw new Error("Invalid GeoNet XML number");
  return Number(v);
};
export const geonetInstant = (v: unknown): string | undefined => {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    return undefined;
  return new Date(v).toISOString().slice(0, 19) === v.slice(0, 19) ? v : undefined;
};
const clock = (v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  const t = geonetInstant(v);
  if (!t) throw new Error("Invalid GeoNet revision clock");
  return t;
};
const ticks = (t: string): bigint =>
  BigInt(Date.parse(t.slice(0, 19) + "Z")) * 1_000_000n +
  BigInt((t.split(".")[1]?.slice(0, -1) ?? "").padEnd(9, "0"));
const creation = (v: unknown): { created?: string; modified?: string } => {
  if (v === undefined) return {};
  if (!isRecord(v)) throw new Error("Invalid GeoNet creationInfo");
  const created = clock(v["creationTime"]),
    modified = clock(v["modificationTime"]);
  if (created && modified && ticks(created) > ticks(modified))
    throw new Error("Reversed GeoNet clocks");
  return { created, modified };
};
type Clocks = ReturnType<typeof creation>;
const latestClock = (c: Clocks): string | undefined => c.modified ?? c.created;

// Resolve namespaces before removing prefixes; an unrelated namesake cannot supply BED data.
function normalizeXml(v: unknown, inherited: Record<string, string> = {}): unknown {
  if (Array.isArray(v)) return v.map((x) => normalizeXml(x, inherited));
  if (!isRecord(v)) return v;
  const ns = { ...inherited };
  for (const [k, value] of Object.entries(v)) {
    if (k === "@_xmlns") ns[""] = String(value);
    else if (k.startsWith("@_xmlns:")) ns[k.slice(9)] = String(value);
  }
  const out: Rec = {};
  for (const [k, value] of Object.entries(v)) {
    if (k.startsWith("@_xmlns") || k === "?xml") continue;
    if (k.startsWith("@_") || k === "#text") {
      out[k] = value;
      continue;
    }
    const [prefix, local] = k.includes(":") ? k.split(":") : ["", k];
    const uri = ns[prefix!];
    const expected =
      local === "quakeml"
        ? "http://quakeml.org/xmlns/quakeml/1.2"
        : "http://quakeml.org/xmlns/bed/1.2";
    // Prefix declarations can be scoped to the element itself.
    const own = obj(Array.isArray(value) ? value[0] : value);
    const actual = own[prefix ? `@_xmlns:${prefix}` : "@_xmlns"] ?? uri;
    if (
      actual !== expected &&
      !(
        ["modificationTime", "passedQC"].includes(local ?? "") &&
        actual === "http://geofon.gfz-potsdam.de/ns/seiscomp3-schema/0.13"
      )
    )
      throw new Error(`Invalid GeoNet XML namespace: ${k} ${actual}`);
    if (Object.hasOwn(out, local!)) throw new Error("Ambiguous GeoNet XML element");
    const normalized = normalizeXml(value, ns);
    out[local!] =
      isRecord(normalized) && Object.keys(normalized).length === 1 && "#text" in normalized
        ? normalized["#text"]
        : normalized;
  }
  return out;
}

export interface GeonetSolution {
  id: string;
  type: string;
  time: string;
  point: [number, number];
  depth?: number;
  magnitude?: { value: number; scale: string };
  reviewed?: boolean;
  preferredOrigin: string;
  preferredMagnitude?: string;
  clocks: { event: Clocks; origin: Clocks; magnitude: Clocks };
}

/** Exact event and preferred references only; other origins/magnitudes cannot fill a missing preference. */
export function geonetSolutions(body: Buffer): GeonetSolution[] {
  const xml = body.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("Invalid GeoNet QuakeML");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: false,
    parseTagValue: false,
  }).parse(xml);
  const normalized = normalizeXml(parsed);
  const root = obj(obj(normalized)["quakeml"]);
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
    if (
      !id ||
      !str(e["preferredOriginID"]) ||
      (e["preferredMagnitudeID"] !== undefined && !str(e["preferredMagnitudeID"])) ||
      origins.length !== 1 ||
      magnitudes.length > 1 ||
      (e["preferredMagnitudeID"] !== undefined && magnitudes.length !== 1)
    )
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
    if (
      (o["depth"] !== undefined && depth === undefined) ||
      (m &&
        (value === undefined ||
          (m["type"] !== undefined && !scale) ||
          m["originID"] !== e["preferredOriginID"]))
    )
      throw new Error("Malformed GeoNet measurement/reference");
    if (
      o["evaluationMode"] !== undefined &&
      !["manual", "automatic"].includes(String(o["evaluationMode"]))
    )
      throw new Error("Unknown GeoNet evaluation mode");
    if (
      o["evaluationStatus"] !== undefined &&
      !["preliminary", "confirmed", "reviewed", "final", "rejected"].includes(
        String(o["evaluationStatus"]),
      )
    )
      throw new Error("Unknown GeoNet evaluation status");
    if (
      ![
        "not existing",
        "not reported",
        "earthquake",
        "anthropogenic event",
        "collapse",
        "cavity collapse",
        "mine collapse",
        "building collapse",
        "explosion",
        "accidental explosion",
        "chemical explosion",
        "controlled explosion",
        "experimental explosion",
        "industrial explosion",
        "mining explosion",
        "quarry blast",
        "road cut",
        "blasting levee",
        "nuclear explosion",
        "induced or triggered event",
        "rock burst",
        "reservoir loading",
        "fluid injection",
        "fluid extraction",
        "crash",
        "plane crash",
        "train crash",
        "boat crash",
        "other event",
        "atmospheric event",
        "sonic boom",
        "sonic blast",
        "acoustic noise",
        "thunder",
        "avalanche",
        "snow avalanche",
        "debris avalanche",
        "hydroacoustic event",
        "ice quake",
        "slide",
        "landslide",
        "rockslide",
        "meteorite",
        "volcanic eruption",
      ].includes(type)
    )
      throw new Error("Unknown GeoNet event type");
    return {
      id,
      preferredOrigin: String(e["preferredOriginID"]),
      preferredMagnitude: str(e["preferredMagnitudeID"]),
      clocks: {
        event: creation(e["creationInfo"]),
        origin: creation(o["creationInfo"]),
        magnitude: creation(m?.["creationInfo"]),
      },
      type,
      time,
      point: [lon, lat],
      ...(depth === undefined ? {} : { depth }),
      ...(value === undefined || scale === undefined ? {} : { magnitude: { value, scale } }),
      ...(o["evaluationMode"] === "manual" ? { reviewed: true } : {}),
    };
  });
}

function validateFeature(raw: Rec): void {
  const p = obj(raw["properties"]);
  if (
    raw["type"] !== "Feature" ||
    typeof p["publicID"] !== "string" ||
    !GEONET_ID.test(p["publicID"]) ||
    typeof p["quality"] !== "string" ||
    !["best", "automatic", "preliminary", "deleted"].includes(p["quality"])
  )
    throw new Error("Invalid GeoNet identity/quality");
  if (!geonetInstant(p["time"])) throw new Error("Invalid GeoNet time");
  clock(p["modificationTime"]);
  for (const key of ["depth", "magnitude", "mmi"]) num(p[key]);
  const mmi = num(p["mmi"]);
  if (mmi !== undefined && mmi !== -1 && (mmi < 0 || mmi > 12))
    throw new Error("Invalid GeoNet MMI");
  if (p["locality"] !== undefined && p["locality"] !== null && !str(p["locality"]))
    throw new Error("Invalid GeoNet locality");
  if (!(p["quality"] === "deleted" && raw["geometry"] === null) && !pointGeometry(raw["geometry"]))
    throw new Error("Invalid GeoNet geometry");
}
export function geonetFeatures(body: Buffer): Rec[] {
  const root = obj(JSON.parse(body.toString("utf8")));
  if (root["type"] !== "FeatureCollection" || !Array.isArray(root["features"]))
    throw new Error("Invalid GeoNet collection");
  return root["features"].map((raw) => {
    if (!isRecord(raw)) throw new Error("Invalid GeoNet feature");
    validateFeature(raw);
    return raw;
  });
}
const featureKey = (f: Rec): string => {
  const p = obj(f["properties"]);
  return JSON.stringify([
    pointGeometry(f["geometry"])?.coordinates ?? null,
    ...["publicID", "time", "depth", "magnitude", "mmi", "locality", "quality"].map(
      (k) => p[k] ?? null,
    ),
  ]);
};
/** Undated current detail must match the newest history solution before inheriting its clock. */
export function geonetRevision(detail: Rec, history: readonly Rec[], fetchedAt: string): Rec {
  for (const f of [detail, ...history]) {
    validateFeature(f);
    const t = clock(obj(f["properties"])["modificationTime"]);
    if (t && ticks(t) > ticks(fetchedAt)) throw new Error("Future GeoNet revision");
  }
  const id = obj(detail["properties"])["publicID"];
  const applicable = history.filter((f) => obj(f["properties"])["publicID"] === id);
  const dated = [detail, ...applicable].filter(
    (f) => obj(f["properties"])["modificationTime"] !== undefined,
  );
  dated.sort((a, b) =>
    ticks(String(obj(a["properties"])["modificationTime"])) <
    ticks(String(obj(b["properties"])["modificationTime"]))
      ? 1
      : -1,
  );
  const newest = dated[0];
  if (!newest) {
    if (applicable.some((f) => featureKey(f) !== featureKey(detail)))
      throw new Error("Incomparable GeoNet history");
    return detail;
  }
  const t = obj(newest["properties"])["modificationTime"];
  if (
    dated.some(
      (f) =>
        ticks(String(obj(f["properties"])["modificationTime"])) === ticks(String(t)) &&
        featureKey(f) !== featureKey(newest),
    )
  )
    throw new Error("Conflicting GeoNet history clock");
  if (
    obj(detail["properties"])["modificationTime"] === undefined &&
    featureKey(detail) !== featureKey(newest)
  )
    throw new Error("Current GeoNet detail/history conflict");
  if (
    applicable.some(
      (f) =>
        obj(f["properties"])["modificationTime"] === undefined &&
        featureKey(f) !== featureKey(newest),
    )
  )
    throw new Error("Incomparable GeoNet history");
  return newest;
}

/** Only an ordered event revision with non-regressing component clocks may supersede a conflict. */
export function geonetSelect(a: GeonetSolution | undefined, b: GeonetSolution): GeonetSolution {
  if (!a) return b;
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  const ac = latestClock(a.clocks.event),
    bc = latestClock(b.clocks.event);
  if (!ac || !bc || ticks(ac) === ticks(bc)) throw new Error("Incomparable GeoNet XML revisions");
  const [older, newer] = ticks(ac) < ticks(bc) ? [a, b] : [b, a];
  for (const component of ["origin", "magnitude"] as const) {
    const x = latestClock(older.clocks[component]),
      y = latestClock(newer.clocks[component]);
    if (
      JSON.stringify(older.clocks[component]) !== JSON.stringify(newer.clocks[component]) &&
      (!x || !y || ticks(y) < ticks(x))
    )
      throw new Error("Conflicting GeoNet component clocks");
  }
  if (
    (older.preferredOrigin !== newer.preferredOrigin ||
      JSON.stringify([older.time, older.point, older.depth, older.reviewed]) !==
        JSON.stringify([newer.time, newer.point, newer.depth, newer.reviewed])) &&
    (!latestClock(older.clocks.origin) ||
      !latestClock(newer.clocks.origin) ||
      ticks(latestClock(newer.clocks.origin)!) <= ticks(latestClock(older.clocks.origin)!))
  )
    throw new Error("Unordered GeoNet origin revision");
  if (
    (older.preferredMagnitude !== newer.preferredMagnitude ||
      JSON.stringify(older.magnitude) !== JSON.stringify(newer.magnitude)) &&
    (!latestClock(older.clocks.magnitude) ||
      !latestClock(newer.clocks.magnitude) ||
      ticks(latestClock(newer.clocks.magnitude)!) <= ticks(latestClock(older.clocks.magnitude)!))
  )
    throw new Error("Unordered GeoNet magnitude revision");
  return newer;
}

export function geonetAddSolution(
  candidates: Map<string, GeonetSolution[]>,
  solution: GeonetSolution,
  at: string,
): GeonetSolution {
  for (const c of Object.values(solution.clocks))
    for (const t of [c.created, c.modified])
      if (t && ticks(t) > ticks(at)) throw new Error("Future GeoNet XML clock");
  const prior = candidates.get(solution.id) ?? [];
  // Check every pair, including older conflicting ties, independently of arrival order.
  for (const other of prior) geonetSelect(other, solution);
  prior.push(solution);
  candidates.set(solution.id, prior);
  return prior.reduce<GeonetSolution | undefined>(geonetSelect, undefined)!;
}

export function geonetDraft(
  feed: HazardsCatalogFeed,
  feature: Rec,
  solution: GeonetSolution | undefined,
  fetchedAt: string,
): RecordDraft | null {
  validateFeature(feature);
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
  if (solution) {
    for (const c of Object.values(solution.clocks))
      for (const t of [c.created, c.modified])
        if (t && ticks(t) > ticks(fetchedAt)) throw new Error("Future GeoNet XML clock");
    const update = clock(p["modificationTime"]),
      event = latestClock(solution.clocks.event);
    // API clocks truncate XML submilliseconds; origin/coordinates are rounded on the API.
    if (
      (update && (!event || Date.parse(update) !== Date.parse(event))) ||
      Math.abs(Date.parse(String(p["time"])) - Date.parse(solution.time)) > 1
    )
      throw new Error("GeoNet API/XML revision conflict");
    const geometry = pointGeometry(feature["geometry"]);
    if (
      geometry &&
      (Math.abs(geometry.coordinates[0]! - solution.point[0]) > 1e-8 ||
        Math.abs(geometry.coordinates[1]! - solution.point[1]) > 1e-8)
    )
      throw new Error("GeoNet API/XML geometry conflict");
    const depth = num(p["depth"]),
      magnitude = num(p["magnitude"]);
    if (
      (depth !== undefined &&
        solution.depth !== undefined &&
        Math.abs(depth * 1000 - solution.depth) > 0.001) ||
      (magnitude !== undefined &&
        solution.magnitude &&
        Math.abs(magnitude - solution.magnitude.value) > 1e-6)
    )
      throw new Error("GeoNet API/XML measurement conflict");
  }
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
  const solutions = new Map<string, GeonetSolution>();
  const candidates = new Map<string, GeonetSolution[]>();
  for (const s of (payloads["solutions"] ?? []).flatMap(geonetSolutions))
    solutions.set(s.id, geonetAddSolution(candidates, s, ctx.fetchedAt));
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
