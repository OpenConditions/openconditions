import {
  defineIngestDomain,
  type FeedFormat,
  type IngestDomain,
} from "@openconditions/ingest-framework";
import { type WeatherCatalogFeed, weatherFeedShape } from "./feed-schema.js";
import { parseDigitrafficWeather, parseDigitrafficWeatherStatus } from "./formats/digitraffic.js";
import { DIGITRAFFIC_SENSORS } from "./formats/digitraffic-sensors.js";

/** What a weather feed publishes: weather stations and what they measure now. */
export const WEATHER_PRODUCTS = ["weather"] as const;

const FORMATS: FeedFormat<WeatherCatalogFeed>[] = [
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
