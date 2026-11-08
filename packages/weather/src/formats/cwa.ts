import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import { WEATHER_PROPERTIES } from "@openconditions/model-weather";
import type { WeatherCatalogFeed } from "../feed-schema.js";
import { instantOf, isRecord, jsonOf, lonLat } from "../records.js";
import { reading, stationDraft } from "../station.js";

export const CWA_CHANNELS = [
  {
    field: "AirTemperature",
    property: "weather.air_temperature",
    unit: "Cel",
    min: -90,
    max: 60,
    aggregation: "instantaneous",
  },
  {
    field: "RelativeHumidity",
    property: "weather.humidity",
    unit: "%",
    min: 0,
    max: 100,
    aggregation: "instantaneous",
  },
  {
    field: "WindSpeed",
    property: "weather.wind_speed",
    unit: "m/s",
    min: 0,
    max: 150,
    aggregation: "mean",
  },
  {
    field: "WindDirection",
    property: "weather.wind_direction",
    unit: "deg",
    min: 0,
    max: 360,
    aggregation: "mean",
  },
] as const;

function decimal(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("CWA expected an object");
  return value;
}

/** REST O-A0003-001 only. Preview captures are tests, never an acquisition fallback. */
export function parseCwaWeather(
  feed: WeatherCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  // Neither station withdrawal nor a complete census is established for this product.
  out.featuresComplete = false;
  const buffers = payloads["main"] ?? [];
  if (!buffers.length) return out;
  if (buffers.length !== 1) throw new Error("CWA requires one coherent unfiltered response");
  const root = object(jsonOf(buffers[0]!, "CWA"));
  if (root["success"] !== "true" || object(root["result"])["resource_id"] !== "O-A0003-001")
    throw new Error("CWA unsuccessful or wrong product");
  if (Object.keys(root).some((k) => !["success", "result", "records"].includes(k)))
    throw new Error("CWA unknown envelope metadata");
  const records = object(root["records"]);
  if (
    Object.keys(records).some((k) => k !== "Station") ||
    !Array.isArray(records["Station"]) ||
    !records["Station"].length
  )
    throw new Error("CWA incomplete station envelope");
  const ids = new Set<string>();
  for (const entry of records["Station"]) {
    const station = object(entry);
    const id = station["StationId"];
    if (typeof id !== "string" || !/^[A-Za-z0-9]+$/.test(id) || ids.has(id))
      throw new Error("CWA invalid or duplicate StationId");
    ids.add(id);
    const geo = object(station["GeoInfo"]);
    if (!Array.isArray(geo["Coordinates"])) throw new Error("CWA coordinates must be an array");
    const coordinates = geo["Coordinates"].map(object);
    const wgs = coordinates.filter((c) => c["CoordinateName"] === "WGS84");
    if (wgs.length !== 1 || wgs[0]!["CoordinateFormat"] !== "decimal degrees")
      throw new Error("CWA requires unique WGS84 geometry");
    const point = lonLat(decimal(wgs[0]!["StationLongitude"]), decimal(wgs[0]!["StationLatitude"]));
    if (!point) throw new Error("CWA invalid WGS84 geometry");
    const sourceTime = object(station["ObsTime"])["DateTime"];
    if (
      typeof sourceTime !== "string" ||
      !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
        sourceTime,
      )
    )
      throw new Error("CWA requires an offset-bearing observation time");
    const measuredAt = instantOf(sourceTime);
    if (!measuredAt || Date.parse(measuredAt) > Date.parse(ctx.fetchedAt))
      throw new Error("CWA invalid or future observation time");
    const values = object(station["WeatherElement"]);
    const properties = CWA_CHANNELS.map((c) => c.property);
    out.features.push(
      stationDraft(feed, ctx.fetchedAt, {
        stationId: id,
        point,
        names:
          typeof station["StationName"] === "string" && station["StationName"].length
            ? [{ lang: "zh", text: station["StationName"] }]
            : [],
        lifecycle: "unknown",
        country: "TW",
        measuredProperties: properties,
        channels: properties.map((property) => ({ key: property, property })),
      }),
    );
    for (const channel of CWA_CHANNELS) {
      const value = decimal(values[channel.field]);
      if (
        value === undefined ||
        value === -99 ||
        value === -98 ||
        value < channel.min ||
        value > channel.max
      ) {
        recordSkipped(feed.id, "unknown_value");
        continue;
      }
      const window = WEATHER_PROPERTIES.find((p) => p.code === channel.property)!
        .freshnessWindowSec!;
      if (Date.parse(ctx.fetchedAt) - Date.parse(measuredAt) >= window * 1000) continue;
      const draft = reading(feed, ctx.fetchedAt, {
        stationId: id,
        point,
        componentKey: channel.property,
        property: channel.property,
        result: { type: "quantity", value, unit: channel.unit },
        measuredAt,
        aggregation: channel.aggregation,
      });
      draft["freshness"] = {
        fetchedAt: ctx.fetchedAt,
        expiresAt: new Date(Date.parse(measuredAt) + window * 1000).toISOString(),
      };
      out.observations.push(draft);
    }
    // Now.Precipitation is a daily accumulation; its exact local reset remains unqualified.
  }
  return out;
}
