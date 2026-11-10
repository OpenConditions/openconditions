import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
  type StatusIndex,
  type StatusOutput,
  type StatusSubject,
} from "@openconditions/ingest-framework";
import type { WeatherCatalogFeed } from "../feed-schema.js";
import { isRecord, jsonOf, lonLat, utcInstant } from "../records.js";
import { reading, stationDraft } from "../station.js";

export const SMHI_PARAMETERS = [
  {
    key: "1",
    property: "weather.air_temperature",
    wireUnit: "celsius",
    unit: "Cel",
    aggregation: "instantaneous",
  },
  {
    key: "39",
    property: "weather.dew_point",
    wireUnit: "celsius",
    unit: "Cel",
    aggregation: "instantaneous",
  },
  {
    key: "6",
    property: "weather.humidity",
    wireUnit: "procent",
    unit: "%",
    aggregation: "instantaneous",
  },
  {
    key: "12",
    property: "weather.visibility",
    wireUnit: "meter",
    unit: "m",
    aggregation: "instantaneous",
  },
  {
    key: "3",
    property: "weather.wind_direction",
    wireUnit: "grader",
    unit: "deg",
    aggregation: "mean",
    windowSec: 600,
  },
  {
    key: "4",
    property: "weather.wind_speed",
    wireUnit: "meter per sekund",
    unit: "m/s",
    aggregation: "mean",
    windowSec: 600,
  },
  {
    key: "21",
    property: "weather.wind_gust",
    wireUnit: "meter per sekund",
    unit: "m/s",
    aggregation: "max",
    windowSec: 3600,
  },
  {
    key: "7",
    property: "weather.precipitation_amount",
    wireUnit: "millimeter",
    unit: "mm",
    aggregation: "sum",
    windowSec: 3600,
  },
] as const;
type Obj = Record<string, unknown>;
interface Subject extends StatusSubject {
  point: readonly [number, number];
  channels: string[];
  from: Record<string, number>;
}
const epoch = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= -62167219200000 && v <= 253402300799999;
const keyOf = (v: unknown): string => {
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("SMHI invalid stable key");
  return v;
};
function envelopes(bodies: readonly Buffer[], status: boolean): Map<string, Obj> {
  const docs = new Map<string, Obj>();
  for (const body of bodies) {
    const doc = jsonOf(body, "SMHI envelope");
    if (!isRecord(doc)) throw new Error("SMHI invalid envelope");
    const parameter = status ? doc["parameter"] : doc;
    if (!isRecord(parameter)) throw new Error("SMHI missing parameter");
    const key = keyOf(parameter["key"]);
    const spec = SMHI_PARAMETERS.find((p) => p.key === key);
    if (
      !spec ||
      docs.has(key) ||
      parameter["unit"] !== spec.wireUnit ||
      !Array.isArray(doc["station"]) ||
      !epoch(doc["updated"])
    )
      throw new Error("SMHI unknown/duplicate parameter, unit or envelope");
    if (status) {
      const period = doc["period"];
      if (
        !isRecord(period) ||
        period["key"] !== "latest-hour" ||
        !epoch(period["from"]) ||
        !epoch(period["to"]) ||
        period["from"] > period["to"]
      )
        throw new Error("SMHI invalid period");
    } else if (doc["valueType"] !== "SAMPLING") throw new Error("SMHI unsupported value type");
    docs.set(key, doc);
  }
  if (docs.size !== SMHI_PARAMETERS.length) throw new Error("SMHI requires all eight parameters");
  return docs;
}
function stations(doc: Obj): Map<string, Obj> {
  const result = new Map<string, Obj>();
  for (const s of doc["station"] as unknown[]) {
    if (!isRecord(s)) throw new Error("SMHI invalid station");
    const key = keyOf(s["key"]);
    if (result.has(key)) throw new Error("SMHI duplicate station");
    result.set(key, s);
  }
  return result;
}
function readings(
  feed: WeatherCatalogFeed,
  docs: Map<string, Obj>,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  const observations = [];
  const rejected = 0;
  const reject = () => {
    recordSkipped(feed.id, "unknown_value");
  };
  const now = Date.parse(ctx.fetchedAt);
  for (const spec of SMHI_PARAMETERS) {
    const doc = docs.get(spec.key)!;
    if ((doc["updated"] as number) > now) throw new Error("SMHI future source clock");
    const period = doc["period"] as Obj;
    for (const [id, s] of stations(doc)) {
      if (s["measuringStations"] !== "CORE") continue;
      const subject = index.get(id)?.[0] as Subject | undefined;
      if (!subject || !subject.channels.includes(spec.key)) {
        if (s["value"] !== null && JSON.stringify(s["value"]) !== "[]") reject();
        continue;
      }
      const point = lonLat(s["longitude"], s["latitude"]);
      if (!point || point[0] !== subject.point[0] || point[1] !== subject.point[1])
        throw new Error("SMHI position changed: refresh metadata before publishing");
      const values = s["value"];
      if (values === null) continue;
      if (!Array.isArray(values)) throw new Error("SMHI invalid values envelope");
      const usable = new Map<number, Obj>();
      for (const v of values) {
        if (
          !isRecord(v) ||
          !epoch(v["date"]) ||
          v["date"] > now ||
          v["date"] > (doc["updated"] as number) ||
          v["date"] < subject.from[spec.key]! ||
          !epoch(s["from"]) ||
          !epoch(s["to"]) ||
          v["date"] < s["from"] ||
          v["date"] > s["to"] ||
          v["date"] < (period["from"] as number) ||
          v["date"] > (period["to"] as number) ||
          now - v["date"] >= 3600000 ||
          typeof v["value"] !== "string" ||
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v["value"]) ||
          !Number.isFinite(Number(v["value"])) ||
          (v["quality"] !== "G" && v["quality"] !== "Y")
        ) {
          reject();
          continue;
        }
        const previous = usable.get(v["date"]);
        if (previous && JSON.stringify(previous) !== JSON.stringify(v))
          throw new Error("SMHI conflicting same-clock duplicates");
        usable.set(v["date"], v);
      }
      const date = Math.max(...usable.keys());
      const v = usable.get(date);
      if (!v) continue;
      const draft = reading(feed, ctx.fetchedAt, {
        stationId: id,
        point: subject.point,
        componentKey: spec.key,
        property: spec.property,
        result: { type: "quantity", value: Number(v["value"]), unit: spec.unit },
        measuredAt: utcInstant(new Date(date)),
        aggregation: spec.aggregation,
        ...("windowSec" in spec ? { windowSec: spec.windowSec } : {}),
        ...(v["quality"] === "Y" ? { supplierCode: "Y" } : {}),
      });
      draft["freshness"] = {
        fetchedAt: ctx.fetchedAt,
        expiresAt: utcInstant(new Date(date + 3600000)),
      };
      draft["validUntil"] = utcInstant(new Date(date + 3600000));
      observations.push(draft);
    }
  }
  return { observations, rejected };
}
export function parseSmhi(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const sites = envelopes(payloads["sites"] ?? [], false);
  const data = envelopes(payloads["status"] ?? [], true);
  const union = new Map<
    string,
    { s: Obj; point: [number, number]; channels: string[]; from: Record<string, number> }
  >();
  for (const spec of SMHI_PARAMETERS)
    for (const [id, s] of stations(sites.get(spec.key)!)) {
      if (s["active"] !== true || s["measuringStations"] !== "CORE") continue;
      const point = lonLat(s["longitude"], s["latitude"]);
      if (
        !point ||
        !epoch(s["from"]) ||
        !epoch(s["to"]) ||
        s["from"] > s["to"] ||
        s["from"] > Date.parse(ctx.fetchedAt)
      )
        throw new Error("SMHI invalid active station geometry/lifespan");
      const prev = union.get(id);
      if (prev && (prev.point[0] !== point[0] || prev.point[1] !== point[1]))
        throw new Error("SMHI incoherent station positions");
      const entry = prev ?? { s, point, channels: [], from: {} };
      entry.channels.push(spec.key);
      entry.from[spec.key] = s["from"];
      union.set(id, entry);
    }
  const out = emptyParseOutput();
  const index = new Map<string, Subject[]>();
  for (const [id, { s, point, channels, from }] of [...union].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const properties = channels.map((key) => SMHI_PARAMETERS.find((p) => p.key === key)!.property);
    const draft = stationDraft(feed, ctx.fetchedAt, {
      stationId: id,
      point,
      names: typeof s["name"] === "string" ? [{ lang: "sv", text: s["name"] }] : [],
      lifecycle: "operational",
      country: "SE",
      measuredProperties: properties,
      channels: channels.map((key, i) => ({ key, property: properties[i]! })),
    });
    draft["extras"] = { owner: s["owner"], measuringStations: s["measuringStations"] };
    out.features.push(draft);
    index.set(id, [{ stationId: id, point, channels, from }]);
  }
  out.statusIndex = index;
  const status = readings(feed, data, ctx, index);
  out.observations = status.observations;
  out.rejected = status.rejected;
  return out;
}
export function parseSmhiStatus(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
  index: StatusIndex,
): StatusOutput {
  return readings(feed, envelopes(payloads["status"] ?? [], true), ctx, index);
}
