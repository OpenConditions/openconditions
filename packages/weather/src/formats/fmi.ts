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
function collection(body: Buffer): Node[] {
  const raw = body.toString("utf8");
  if (
    raw.length > 8_000_000 ||
    /<!DOCTYPE|<!ENTITY/i.test(raw) ||
    XMLValidator.validate(raw) !== true
  )
    return fail("invalid or oversized XML");
  for (const [prefix, uri] of Object.entries(namespaces))
    for (const match of raw.matchAll(new RegExp(`xmlns:${prefix}="([^"]*)"`, "g")))
      if (match[1] !== uri) fail("invalid namespace");
  for (const [prefix, uri] of Object.entries(namespaces)) {
    if (raw.includes(`<${prefix}:`) && !raw.includes(`xmlns:${prefix}="${uri}"`))
      fail("undeclared namespace");
  }
  if (!raw.includes(`xmlns:wfs="${namespaces.wfs}"`)) return fail("missing WFS namespace");
  // Restrictive/unknown source statements require review; never overwrite last-good rights with a catalogue grant.
  if (/<(?:\w+:)?(?:accessConstraints|useLimitation|otherConstraints)\b/i.test(raw))
    return fail("upstream rights require review");
  const root = parser.parse(raw)["wfs:FeatureCollection"] as unknown;
  if (!isRecord(root)) return fail("not a FeatureCollection");
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
  const xy = text(n, "gml:pos").split(/\s+/).map(Number);
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
  const v = all(n, "gml:identifier").find((x) => attr(x, "codeSpace") === FMISID);
  const s = str(v);
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
) {
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
      const positions = text(d, "gmlcov:positions").split(/\s+/).map(Number);
      const values = text(c, "gml:doubleOrNilReasonTupleList").split(/\s+/);
      if (positions.length % 3 || values.length !== (positions.length / 3) * fields.length)
        return fail("tuple cardinality");
      const points = new Map<string, string>();
      const pointNodes = all(member, "gml:Point");
      for (const loc of all(member, "target:Location")) {
        const ref = attr(nodes(loc["target:representativePoint"])[0] ?? {}, "xlink:href");
        const p = pointNodes.find((x) => `#${attr(x, "gml:id")}` === ref);
        if (!p) return fail("unresolved representativePoint");
        const xy = point(p);
        const key = xy.join(",");
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
        if (!station || station.lifecycle !== "operational") continue;
        if (time > at || at - time > 3600_000) continue;
        fields.forEach((field, j) => {
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
  // Observation point precision is the source's measurement geometry; metadata uses more digits.
  for (const body of payloads.status ?? [])
    for (const member of collection(body))
      for (const loc of all(member, "target:Location")) {
        const s = index.get(id(loc));
        if (!s) continue;
        const ref = attr(nodes(loc["target:representativePoint"])[0] ?? {}, "xlink:href");
        const p = all(member, "gml:Point").find((x) => `#${attr(x, "gml:id")}` === ref);
        if (p) s.point = point(p);
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
  out.observations = observations(feed, payloads.status ?? [], ctx, index);
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
