import {
  defineIngestDomain,
  type FeedFormat,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import { type WeatherCatalogFeed, weatherFeedShape } from "./feed-schema.js";
import { parseDigitrafficWeather, parseDigitrafficWeatherStatus } from "./formats/digitraffic.js";
import { DIGITRAFFIC_SENSORS } from "./formats/digitraffic-sensors.js";
import { DWD_PROPERTIES, DWD_ROLES, parseDwd } from "./formats/dwd.js";
import { ECCC_MEASUREMENTS, parseEccc, parseEcccStatus } from "./formats/eccc.js";
import { FMI_PARAMETERS, parseFmiWeather, parseFmiWeatherStatus } from "./formats/fmi.js";
import { parseSmhi, parseSmhiStatus, SMHI_PARAMETERS } from "./formats/smhi.js";

/** What a weather feed publishes: weather stations and what they measure now. */
export const WEATHER_PRODUCTS = ["weather"] as const;

const FORMATS: FeedFormat<WeatherCatalogFeed>[] = [
  {
    id: "fmi-weather",
    transactionalRoles: true,
    kind: "features",
    products: WEATHER_PRODUCTS,
    produces: {
      kinds: ["weather_station", "sensor_channel"],
      properties: FMI_PARAMETERS.map((p) => p.property),
    },
    endpoints: { sites: { required: true }, status: { required: true, status: true } },
    parse: parseFmiWeather,
    parseStatus: parseFmiWeatherStatus,
  },
  {
    id: "eccc-swob",
    atomicCandidate: true,
    kind: "features",
    products: WEATHER_PRODUCTS,
    produces: { kinds: ["weather_station"], properties: ECCC_MEASUREMENTS.map((s) => s.property) },
    endpoints: { sites: { required: true }, status: { required: true, status: true } },
    parse: parseEccc,
    parseStatus: parseEcccStatus,
  },
  {
    id: "dwd-cdc-10min",
    kind: "features",
    products: WEATHER_PRODUCTS,
    produces: { kinds: ["weather_station", "sensor_channel"], properties: DWD_PROPERTIES },
    endpoints: Object.fromEntries(
      DWD_ROLES.flatMap((role) => [
        [`${role}_stations`, { required: true }],
        [`${role}_listing`, { required: true }],
        [role, { required: true }],
      ]),
    ),
    parse: parseDwd,
  },
  {
    id: "smhi-metobs",
    kind: "features",
    products: WEATHER_PRODUCTS,
    produces: {
      kinds: ["weather_station", "sensor_channel"],
      properties: SMHI_PARAMETERS.map((p) => p.property),
    },
    endpoints: { sites: { required: true }, status: { required: true, status: true } },
    parse: parseSmhi,
    parseStatus: parseSmhiStatus,
  },
  {
    id: "digitraffic-weather",
    kind: "features",
    products: WEATHER_PRODUCTS,
    produces: {
      kinds: ["weather_station", "sensor_channel"],
      properties: [...new Set(DIGITRAFFIC_SENSORS.map((s) => s.property)), "device.status"],
    },
    // The station list, each station's details, and every station's latest
    // values, which poll on their own between the daily lists.
    endpoints: {
      sites: { required: true },
      details: { required: false },
      status: { required: false, status: true },
    },
    parse: parseDigitrafficWeather,
    parseStatus: parseDigitrafficWeatherStatus,
  },
];

/**
 * The weather domain: road weather and meteorological stations, the sensor
 * channels each has, and their current weather and road-surface readings.
 * The records are the model's weather kinds and properties.
 */
export const weatherDomain: IngestDomain<WeatherCatalogFeed> =
  defineIngestDomain<WeatherCatalogFeed>({
    id: "weather",
    products: WEATHER_PRODUCTS,
    feedShape: weatherFeedShape,
    formats: Object.fromEntries(FORMATS.map((format) => [format.id, format])),
    resolvers: [],
  });
