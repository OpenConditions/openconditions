import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
} from "@openconditions/ingest-framework";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { WeatherCatalogFeed } from "../feed-schema.js";
import { isRecord, utcInstant } from "../records.js";
import { reading, stationDraft } from "../station.js";

/** Precipitation channels remain withheld pending channel-specific sentinel qualification. */
export const FMI_PARAMETERS = [
  {
    key: "t2m",
    property: "weather.air_temperature",
    unit: "Cel",
    windowSec: 60,
    aggregation: "mean",
    min: -100,
    max: 65,
  },
  {
    key: "td",
    property: "weather.dew_point",
    unit: "Cel",
    windowSec: 60,
    aggregation: "mean",
    min: -100,
    max: 65,
  },
  {
    key: "rh",
    property: "weather.humidity",
    unit: "%",
    windowSec: 60,
    aggregation: "mean",
    min: 0,
    max: 100,
  },
  {
    key: "vis",
    property: "weather.visibility",
    unit: "m",
    windowSec: 60,
    aggregation: "mean",
    min: 0,
    max: 100000,
  },
  {
    key: "ws_10min",
    property: "weather.wind_speed",
    unit: "m/s",
    windowSec: 600,
    aggregation: "mean",
    min: 0,
    max: 150,
  },
  {
    key: "wd_10min",
    property: "weather.wind_direction",
    unit: "deg",
    windowSec: 600,
    aggregation: "mean",
    min: 0,
    max: 360,
  },
  {
    key: "wg_10min",
    property: "weather.wind_gust",
    unit: "m/s",
    windowSec: 600,
    aggregation: "max",
    min: 0,
    max: 150,
  },
] as const;
const namespaces: Record<string, string> = {
  wfs: "http://www.opengis.net/wfs/2.0",
  gml: "http://www.opengis.net/gml/3.2",
  gmlcov: "http://www.opengis.net/gmlcov/1.0",
  swe: "http://www.opengis.net/swe/2.0",
  target: "http://xml.fmi.fi/namespace/om/atmosphericfeatures/1.1",
  ef: "http://inspire.ec.europa.eu/schemas/ef/4.0",
  xlink: "http://www.w3.org/1999/xlink",
  om: "http://www.opengis.net/om/2.0",
  omso: "http://inspire.ec.europa.eu/schemas/omso/3.0",
};
const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: false,
  parseAttributeValue: false,
});
type Node = Record<string, unknown>;
const nodes = (v: unknown): Node[] => (Array.isArray(v) ? v : [v]).filter(isRecord);
const str = (v: unknown): string =>
  typeof v === "string" ? v.trim() : isRecord(v) ? str(v["#text"]) : "";
const attr = (n: Node, k: string) => str(n[`@_${k}`]);
function all(n: unknown, key: string): Node[] {
  if (!isRecord(n)) return [];
  return Object.entries(n).flatMap(([k, v]) =>
    k === key ? nodes(v) : nodes(v).flatMap((x) => all(x, key)),
  );
}
function text(n: unknown, key: string): string {
  if (!isRecord(n)) return "";
  for (const [k, v] of Object.entries(n)) {
    if (k === key) return str(v);
    for (const child of nodes(v)) {
      const t = text(child, key);
      if (t) return t;
    }
  }
  return "";
}
const fail = (why: string): never => {
  throw new Error(`FMI: ${why}`);
};
// Resolve names against each element's own scope, including declarations on that element.
function bindings(n: Node, inherited: Record<string, string>): Record<string, string> {
  const scope = { ...inherited };
  for (const [key, value] of Object.entries(n)) {
    if (key !== "@_xmlns" && !key.startsWith("@_xmlns:")) continue;
    const prefix = key === "@_xmlns" ? "" : key.slice(8);
    const uri = str(value);
    if (
      typeof value !== "string" ||
      value !== uri ||
      /\s/.test(uri) ||
      (prefix && !/^[A-Za-z_][\w.-]*$/.test(prefix))
    )
      fail("invalid namespace declaration");
    if (
      prefix === "xmlns" ||
      (prefix === "xml" && uri !== "http://www.w3.org/XML/1998/namespace") ||
      (prefix && !uri) ||
      uri === "http://www.w3.org/2000/xmlns/" ||
      (prefix !== "xml" && uri === "http://www.w3.org/XML/1998/namespace")
    )
      fail("invalid namespace declaration");
    scope[prefix] = uri;
  }
  return scope;
}
function expanded(name: string, scope: Record<string, string>, attribute = false): string {
  const parts = name.split(":");
  if (parts.length > 2 || parts.some((p) => !/^[A-Za-z_][\w.-]*$/.test(p)))
    return fail("invalid XML name");
  const local = parts.at(-1)!;
  if (/^(accessConstraints|useLimitation|otherConstraints)$/i.test(local))
    fail("upstream rights require review");
  const prefix = parts.length === 2 ? parts[0]! : "";
  const uri = prefix || !attribute ? scope[prefix] : "";
  if (prefix && !uri) return fail("undeclared namespace");
  if (prefix in namespaces && uri !== namespaces[prefix]) return fail("invalid namespace");
  const canonical = Object.entries(namespaces).find(([, u]) => u === uri)?.[0];
  return canonical ? `${canonical}:${local}` : uri ? `{${uri}}${local}` : local;
}
function normalizeXml(n: Node, inherited: Record<string, string>): Node {
  const scope = bindings(n, inherited);
  const result: Node = {};
  for (const [key, value] of Object.entries(n)) {
    if (key === "@_xmlns" || key.startsWith("@_xmlns:") || key.startsWith("?")) continue;
    if (key === "#text") {
      result[key] = value;
      continue;
    }
    if (key.startsWith("@_")) {
      const name = "@_" + expanded(key.slice(2), scope, true);
      if (name in result) fail("duplicate expanded attribute");
      result[name] = value;
      continue;
    }
    for (const child of Array.isArray(value) ? value : [value]) {
      const own = isRecord(child) ? bindings(child, scope) : scope;
      const name = expanded(key, own);
      const normalized = isRecord(child) ? normalizeXml(child, scope) : child;
      if (name in result)
        result[name] = [
          ...((Array.isArray(result[name]) ? result[name] : [result[name]]) as unknown[]),
          normalized,
        ];
      else result[name] = normalized;
    }
  }
  return result;
}
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function coordinate(token: string): number {
  if (!decimal.test(token) || !Number.isFinite(Number(token)))
    return fail("invalid coordinate token");
  return Number(token);
}
function collection(body: Buffer): Node[] {
  const raw = body.toString("utf8");
  if (
    raw.length > 8_000_000 ||
    /<!DOCTYPE|<!ENTITY/i.test(raw) ||
    XMLValidator.validate(raw) !== true
  )
    return fail("invalid or oversized XML");
  const root = normalizeXml(parser.parse(raw), { xml: "http://www.w3.org/XML/1998/namespace" })[
    "wfs:FeatureCollection"
  ];
  if (!isRecord(root)) return fail("not a FeatureCollection");
  const references = new Set(
    all(root, "target:representativePoint").map((p) => attr(p, "xlink:href")),
  );
  const pointIds = all(root, "gml:Point")
    .map((p) => attr(p, "gml:id"))
    .filter((id) => references.has(`#${id}`));
  if (new Set(pointIds).size !== pointIds.length) fail("ambiguous point IDs");
  const members = nodes(root["wfs:member"]);
  const returned = attr(root, "numberReturned"),
    matched = attr(root, "numberMatched");
  if (!/^\d+$/.test(returned) || returned !== matched || Number(returned) !== members.length)
    return fail("incomplete coverage member count");
  return members;
}
function point(n: Node, finnish = true): [number, number] {
  const crs = attr(n, "srsName");
  if (
    !/\/EPSG\/0\/(4258|4326)$/.test(crs) ||
    attr(n, "srsDimension") !== "2" ||
    (attr(n, "axisLabels") && attr(n, "axisLabels") !== "Lat Long")
  )
    return fail("unsupported point CRS or axes");
  const xy = text(n, "gml:pos").split(/\s+/).map(coordinate);
  if (
    xy.length !== 2 ||
    !xy.every(Number.isFinite) ||
    Math.abs(xy[0]!) > 90 ||
    Math.abs(xy[1]!) > 180
  )
    fail("invalid position");
  if (finnish && (xy[0]! < 59 || xy[0]! > 70.2 || xy[1]! < 19 || xy[1]! > 32))
    fail("invalid Finnish position");
  return [xy[1]!, xy[0]!];
}
const FMISID = "http://xml.fmi.fi/namespace/stationcode/fmisid";
function id(n: Node): string {
  const identifiers = all(n, "gml:identifier").filter((x) => attr(x, "codeSpace") === FMISID);
  if (identifiers.length !== 1) return fail("ambiguous FMISID");
  const s = str(identifiers[0]);
  if (!/^\d+$/.test(s)) return fail("missing FMISID");
  return s;
}
function named(n: Node, suffix: string): string {
  return str(all(n, "gml:name").find((x) => attr(x, "codeSpace").endsWith(suffix)));
}
function instant(s: string): number {
  const t = Date.parse(s);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s) ||
    !Number.isFinite(t) ||
    new Date(t).toISOString().slice(0, 19) !== s.slice(0, 19)
  )
    return fail("invalid UTC instant");
  return t;
}
interface Station {
  stationId: string;
  point: [number, number];
  name: string;
  wmo: string;
  lifecycle: "operational" | "decommissioned";
}
function stations(
  feed: WeatherCatalogFeed,
  bodies: readonly Buffer[],
  at: number,
): Map<string, Station> {
  const result = new Map<string, Station>();
  for (const body of bodies)
    for (const member of collection(body)) {
      const n = nodes(member["ef:EnvironmentalMonitoringFacility"])[0];
      if (!n) return fail("missing environmental metadata");
      const country = named(n, "/country");
      if (country !== "Finland") {
        recordSkipped(feed.id, "unknown_type");
        continue;
      }
      if (
        !all(n, "ef:belongsTo").some((x) =>
          /[?&]networkid=(121|122|224)&?$/.test(attr(x, "xlink:href")),
        )
      )
        continue;
      const p = all(n, "gml:Point");
      if (p.length !== 1) return fail("missing metadata position");
      const metadataPoint = point(p[0]!, false);
      if (
        metadataPoint[1] < 59 ||
        metadataPoint[1] > 70.2 ||
        metadataPoint[0] < 19 ||
        metadataPoint[0] > 32
      )
        continue;
      const period = all(n, "gml:TimePeriod");
      if (period.length !== 1) return fail("missing activity period");
      const begin = instant(text(period[0], "gml:beginPosition"));
      if (begin > at) continue;
      const end = text(period[0], "gml:endPosition");
      if (
        !end &&
        attr(nodes(period[0]!["gml:endPosition"])[0] ?? {}, "indeterminatePosition") !== "now"
      )
        return fail("unknown activity end");
      const station: Station = {
        stationId: id(n),
        point: metadataPoint,
        name: named(n, "/name"),
        wmo: named(n, "/wmo"),
        lifecycle: end && instant(end) <= at ? "decommissioned" : "operational",
      };
      const prior = result.get(station.stationId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(station))
        return fail("conflicting metadata");
      result.set(station.stationId, station);
    }
  return result;
}
function observations(
  feed: WeatherCatalogFeed,
  bodies: readonly Buffer[],
  ctx: ParseContext,
  index: ReadonlyMap<string, Station>,
  geometry = new Map<string, [number, number]>(),
) {
  const identity = new Map<string, string>();
  const identitiesAt = new Map<string, string>();
  const tuples = new Map<string, string>();
  const latest = new Map<string, { epoch: number; draft: Record<string, unknown> }>();
  const at = instant(ctx.fetchedAt.replace(/\.000Z$/, "Z"));
  for (const body of bodies)
    for (const member of collection(body)) {
      const cover = all(member, "gmlcov:MultiPointCoverage");
      if (cover.length !== 1) return fail("missing coverage");
      const c = cover[0]!;
      const domain = all(c, "gmlcov:SimpleMultiPoint");
      if (domain.length !== 1) return fail("missing domain");
      const d = domain[0]!;
      if (
        attr(d, "srsDimension") !== "3" ||
        (attr(d, "axisLabels") !== "" && attr(d, "axisLabels") !== "Lat Long time") ||
        !/^http:\/\/xml.fmi.fi\/gml\/crs\/compoundCRS.php\?crs=(4258|4326)&time=unixtime$/.test(
          attr(d, "srsName"),
        )
      )
        return fail("unsupported coverage CRS");
      const fields = all(c, "swe:field").map((x) => attr(x, "name"));
      if (!fields.length || new Set(fields).size !== fields.length) return fail("invalid fields");
      if (
        fields.some(
          (field) =>
            !FMI_PARAMETERS.some((p) => p.key === field) &&
            field !== "r_1h" &&
            field !== "ri_10min",
        )
      )
        fail("unknown field or QC semantics");
      const tokens = text(d, "gmlcov:positions").split(/\s+/);
      const positions = tokens.map((token, i) => {
        if (i % 3 !== 2) return coordinate(token);
        if (!/^\d+$/.test(token)) return fail("invalid epoch token");
        return Number(token);
      });
      const values = text(c, "gml:doubleOrNilReasonTupleList").split(/\s+/);
      if (positions.length % 3 || values.length !== (positions.length / 3) * fields.length)
        return fail("tuple cardinality");
      const points = new Map<string, string>();
      const pointNodes = all(member, "gml:Point");
      for (const loc of all(member, "target:Location")) {
        const references = nodes(loc["target:representativePoint"]);
        if (references.length !== 1) return fail("ambiguous representativePoint");
        const ref = attr(references[0]!, "xlink:href");
        const matches = pointNodes.filter((x) => `#${attr(x, "gml:id")}` === ref);
        const p = matches[0];
        if (matches.length !== 1 || !ref.startsWith("#") || !p)
          return fail("unresolved representativePoint");
        const xy = point(p);
        const key = xy.join(",");
        const stationId = id(loc);
        if (identity.has(stationId) && identity.get(stationId) !== key)
          fail("conflicting station position");
        if (identitiesAt.has(key) && identitiesAt.get(key) !== stationId)
          fail("ambiguous generation position join");
        identitiesAt.set(key, stationId);
        identity.set(stationId, key);
        geometry.set(stationId, xy);
        const metadata = index.get(stationId);
        if (metadata && metadata.point.some((v, i) => Math.abs(v - xy[i]!) > 0.000011))
          fail("metadata observation position conflict");
        if (points.has(key) && points.get(key) !== id(loc)) return fail("ambiguous position join");
        points.set(key, id(loc));
      }
      const start = instant(text(member, "gml:beginPosition"));
      const end = instant(text(member, "gml:endPosition"));
      if (start > end) return fail("inverted window");
      for (let i = 0; i < positions.length; i += 3) {
        const lat = positions[i]!,
          lon = positions[i + 1]!,
          epoch = positions[i + 2]!;
        if (
          ![lat, lon, epoch].every(Number.isFinite) ||
          !Number.isSafeInteger(epoch) ||
          epoch < 0 ||
          epoch > 253402300799
        )
          return fail("invalid position or epoch");
        const time = epoch * 1000;
        if (time < start || time > end) return fail("sample outside phenomenon window");
        const stationId = points.get([lon, lat].join(","));
        if (!stationId) return fail("unjoined position");
        const station = index.get(stationId);
        fields.forEach((field, j) => {
          const tupleKey = `${stationId}:${epoch}:${field}`;
          const tuple = values[(i / 3) * fields.length + j]!;
          if (tuples.has(tupleKey) && tuples.get(tupleKey) !== tuple)
            fail("conflicting duplicate tuple");
          tuples.set(tupleKey, tuple);
          if (!station || station.lifecycle !== "operational" || time > at || at - time > 3600_000)
            return;
          const param = FMI_PARAMETERS.find((x) => x.key === field);
          if (!param) return;
          const raw = values[(i / 3) * fields.length + j]!;
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return;
          const value = Number(raw);
          if (!Number.isFinite(value) || value < param.min || value > param.max) return;
          const draft = reading(feed, ctx.fetchedAt, {
            stationId,
            point: [lon, lat],
            componentKey: field,
            property: param.property,
            result: { type: "quantity", unit: param.unit, value },
            measuredAt: utcInstant(new Date(time)),
            windowSec: param.windowSec,
            aggregation: param.aggregation,
          });
          draft.freshness = {
            fetchedAt: ctx.fetchedAt,
            expiresAt: utcInstant(new Date(time + 3600_000)),
          };
          const key = `${stationId}:${field}`;
          const prior = latest.get(key);
          if (!prior || epoch >= prior.epoch) latest.set(key, { epoch, draft });
        });
      }
    }
  return [...latest.values()].map((x) => x.draft);
}
export function parseFmiWeather(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  out.featuresComplete = false;
  if (!payloads.sites?.length) return out;
  const index = stations(feed, payloads.sites, instant(ctx.fetchedAt.replace(/\.000Z$/, "Z")));
  const geometry = new Map<string, [number, number]>();
  out.observations = observations(feed, payloads.status ?? [], ctx, index, geometry);
  // Source observation geometry rounds metadata coordinates to five decimal places.
  for (const [stationId, xy] of geometry) {
    const station = index.get(stationId);
    if (station) station.point = xy;
  }
  out.features = [...index.values()].map((s) =>
    stationDraft(feed, ctx.fetchedAt, {
      ...s,
      names: s.name ? [{ text: s.name, lang: "fi" }] : [],
      country: "FI",
      external: s.wmo ? [{ system: "wmo", code: s.wmo }] : [],
      measuredProperties: FMI_PARAMETERS.map((p) => p.property),
      channels: FMI_PARAMETERS.map((p) => ({ key: p.key, property: p.property })),
    }),
  );
  out.statusIndex = new Map([...index].map(([key, s]) => [key, [s]]));
  return out;
}
export function parseFmiWeatherStatus(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  const stations = new Map<string, Station>();
  for (const [key, subjects] of index) {
    const s = subjects[0] as Station | undefined;
    if (s?.point) stations.set(key, s);
  }
  return { observations: observations(feed, payloads.status ?? [], ctx, stations), rejected: 0 };
}
