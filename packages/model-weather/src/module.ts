import {
  defineDomain,
  defineKind,
  defineProperty,
  defineVocabulary,
  inClassPaths,
  type MappingTarget,
  type PropertyEntry,
  type RegistryModule,
  type Retention,
  type SourceCrosswalk,
  type SubjectSpec,
  vocabularyCrosswalk,
  withPropertyCrosswalks,
} from "@openconditions/model";
import { z } from "zod";
import {
  DATEX2_MEASURED_WEATHER,
  DATEX2_PRECIPITATION_TYPES,
  DATEX2_ROAD_CONDITIONS,
} from "./crosswalk/datex2.js";
import { DATEX2_V2_WEATHER, DATEX2_V3_WEATHER } from "./vocabularies/datex2.js";

const DOMAIN = "weather";
const V = "1.0";
const HOUR = 3600;

export const PRECIPITATION_TYPES = [
  "none",
  "rain",
  "snow",
  "sleet",
  "hail",
  "drizzle",
  "freezing_rain",
] as const;

/** A weather or road-surface value measured at a site, or on one of its sensors. */
const SITE: SubjectSpec = {
  kind: "feature",
  traits: ["weather_sensing"],
  componentKinds: ["sensor_channel"],
};
const SERIES: Retention = { rawDays: 7, rollup: { period: "hourly" } };

const quantity = (
  code: string,
  unit: string,
  description: string,
  retention: Retention = SERIES,
): PropertyEntry =>
  defineProperty({
    code,
    domain: DOMAIN,
    version: V,
    description,
    result: { type: "quantity", unit },
    subjects: [SITE],
    freshnessWindowSec: HOUR,
    retention,
  });

/** The measured and forecast weather and road-surface properties. */
export const WEATHER_PROPERTIES: PropertyEntry[] = [
  quantity("weather.air_temperature", "Cel", "Air temperature."),
  quantity("weather.dew_point", "Cel", "Dew point temperature."),
  quantity("weather.humidity", "%", "Relative humidity."),
  quantity("weather.visibility", "m", "Visibility distance."),
  quantity("weather.wind_speed", "m/s", "Mean wind speed."),
  quantity("weather.wind_gust", "m/s", "Maximum gust speed."),
  // An hourly mean of compass bearings is meaningless (359° and 1° average to 180°).
  quantity("weather.wind_direction", "deg", "Direction the wind blows from.", { rawDays: 7 }),
  quantity("weather.precipitation_rate", "mm/h", "Precipitation intensity."),
  defineProperty({
    code: "weather.precipitation_type",
    domain: DOMAIN,
    version: V,
    description: "What is falling.",
    result: { type: "category", vocabulary: "precipitation_type" },
    subjects: [SITE],
    freshnessWindowSec: HOUR,
    retention: { changeOnly: true },
  }),
  defineProperty({
    code: "road.surface_state",
    domain: DOMAIN,
    version: V,
    description: "The state of the road surface at a sensor or along segments.",
    result: { type: "category", vocabulary: "surface_state" },
    subjects: [SITE, { kind: "segments" }],
    freshnessWindowSec: HOUR,
    retention: { changeOnly: true },
    routingRelevant: true,
  }),
  quantity("road.surface_temperature", "Cel", "Road surface temperature."),
  quantity("road.subsurface_temperature", "Cel", "Temperature below the road surface."),
  quantity("road.freezing_point", "Cel", "Freezing point of the water on the surface."),
  quantity("road.friction", "1", "Friction coefficient of the surface."),
  quantity("road.water_film", "mm", "Water film thickness."),
  quantity("road.snow_depth", "mm", "Snow depth on the surface."),
  quantity("road.ice_thickness", "mm", "Ice layer thickness."),
  // Sources publish mass per volume of the surface solution (DATEX kg/m³, Digitraffic g/l), never a percentage.
  quantity(
    "road.salt_concentration",
    "kg/m3",
    "De-icing salt concentration of the surface solution.",
  ),
  defineProperty({
    code: "road.condition_forecast",
    domain: DOMAIN,
    version: V,
    description: "Forecast road surface state for a segment or area.",
    result: { type: "category", vocabulary: "surface_state" },
    subjects: [{ kind: "segments" }, { kind: "location" }],
    retention: { rawDays: 2 },
  }),
];

type DatexWeather = typeof DATEX2_V3_WEATHER | typeof DATEX2_V2_WEATHER;

const datex = (
  table: Readonly<Record<string, string | null>>,
  include: (v: DatexWeather) => (code: string) => boolean,
): SourceCrosswalk[] =>
  (
    [
      ["datex2_v3", DATEX2_V3_WEATHER],
      ["datex2_v2", DATEX2_V2_WEATHER],
    ] as [MappingTarget, DatexWeather][]
  ).map(([target, v]) => ({ target, table, include: include(v) }));

const listed = (values: readonly string[]) => (code: string) => values.includes(code);

/** The weather registry module: measured and forecast meteorological and road-weather data, no warnings. */
export const weatherModule: RegistryModule = {
  name: "weather",
  entries: [
    defineDomain({
      code: DOMAIN,
      description:
        "Measured and forecast meteorological and road-weather data. Warnings are hazards.",
    }),
    defineVocabulary({
      code: "precipitation_type",
      values: PRECIPITATION_TYPES,
      extensible: false,
      description: "What is falling.",
    }),
    vocabularyCrosswalk(
      "precipitation_type",
      datex(DATEX2_PRECIPITATION_TYPES, (v) => listed(v.precipitationTypes)),
      [],
    ),
    vocabularyCrosswalk(
      "surface_state",
      datex(DATEX2_ROAD_CONDITIONS, (v) => listed(v.roadConditionTypes)),
      [],
    ),
    defineKind({
      class: "feature",
      code: "weather_station",
      domain: DOMAIN,
      version: V,
      description:
        "A road-weather or meteorological station; a site measuring only weather and road-surface values.",
      components: ["sensor_channel"],
      traits: ["field_device", "weather_sensing"],
      details: () => ({
        equipment: z.array(z.string().min(1)).min(1).optional(),
        /** The properties the station reports; registered property codes. */
        measuredProperties: z.array(z.string().min(1)).min(1),
        surfaceSensorCount: z.number().int().nonnegative().optional(),
      }),
    }),
    ...withPropertyCrosswalks(
      WEATHER_PROPERTIES,
      datex(DATEX2_MEASURED_WEATHER, (v) => inClassPaths(v.measuredValues)),
      [],
    ),
  ],
};
