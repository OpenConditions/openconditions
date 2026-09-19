/**
 * DATEX II `PrecipitationTypeEnum` (both versions) → `precipitation_type`.
 * Version 3 follows the WMO list, which also names deposits (dew, rime,
 * hoar frost): those are not precipitation, and neither is an unspecified
 * solid type, so they stay unmapped.
 */
export const DATEX2_PRECIPITATION_TYPES: Readonly<Record<string, string | null>> = {
  noPrecipitation: "none",
  rain: "rain",
  liquidNotFreezing: "rain",
  drizzle: "drizzle",
  freezingRain: "freezing_rain",
  liquidFreezing: "freezing_rain",
  glaze: "freezing_rain",
  clearIce: "freezing_rain",
  sleet: "sleet",
  icePellets: "sleet",
  snow: "snow",
  wetSnow: "snow",
  snowGrains: "snow",
  diamondDust: "snow",
  iceCrystals: "snow",
  hail: "hail",
  smallHail: "hail",
  snowPellets: "hail",
  solid: null,
  dew: null,
  whiteDev: null,
  rime: null,
  softRime: null,
  hardRime: null,
  hoarFrost: null,
  unknown: null,
  _extended: null,
};

/**
 * DATEX II `WeatherRelatedRoadConditionTypeEnum` (both versions) →
 * `surface_state`, for measured road-surface states. Pedestrian-pavement
 * conditions, a generic "slippery", and asphalt melting in heat describe no
 * carriageway surface state.
 */
export const DATEX2_ROAD_CONDITIONS: Readonly<Record<string, string | null>> = {
  dry: "dry",
  moist: "damp",
  notDry: "damp",
  wet: "wet",
  surfaceWater: "standing_water",
  streamingWater: "standing_water",
  rime: "frost",
  blackIce: "black_ice",
  ice: "ice",
  iceBuildUp: "ice",
  iceWithWheelBarTracks: "ice",
  icyPatches: "ice",
  glaze: "ice",
  freezingRain: "ice",
  freezingOfWetRoads: "ice",
  wetAndIcyRoad: "ice",
  snow: "snow",
  snowOnTheRoad: "snow",
  freshSnow: "snow",
  deepSnow: "snow",
  looseSnow: "snow",
  snowDrifts: "snow",
  packedSnow: "packed_snow",
  slushOnRoad: "slush",
  slushStrings: "slush",
  slippery: null,
  slipperyRoad: null,
  roadSurfaceMelting: null,
  freezingPavements: null,
  snowOnPavement: null,
  wetIcyPavement: null,
  normalWinterConditionsForPedestrians: null,
  other: null,
  _extended: null,
};

/**
 * DATEX II weather measured values → properties, keyed `<class>/<path>` (a
 * class key covers the whole class). Maximum and minimum temperatures are
 * `weather.air_temperature` observations with that aggregation; the maximum
 * wind speed of the period is the gust. Pressure and pollution have no
 * property yet (pollution belongs to the environment domain); sensor
 * metadata (measurement heights) belongs on the sensor channel.
 */
export const DATEX2_MEASURED_WEATHER: Readonly<Record<string, string | null>> = {
  "TemperatureInformation/temperature/airTemperature": "weather.air_temperature",
  "TemperatureInformation/temperature/maximumTemperature": "weather.air_temperature",
  "TemperatureInformation/temperature/minimumTemperature": "weather.air_temperature",
  "TemperatureInformation/temperature/dewPointTemperature": "weather.dew_point",
  "HumidityInformation/humidity/relativeHumidity": "weather.humidity",
  "VisibilityInformation/visibility/minimumVisibilityDistance": "weather.visibility",
  "WindInformation/wind/windSpeed": "weather.wind_speed",
  "WindInformation/wind/maximumWindSpeed": "weather.wind_gust",
  "WindInformation/wind/windDirectionBearing": "weather.wind_direction",
  "WindInformation/wind/windDirectionCompass": "weather.wind_direction",
  "WindInformation/wind/maximumWindDirectionBearing": null,
  "WindInformation/wind/maximumWindDirectionCompass": null,
  "WindInformation/wind/windMeasurementHeight": null,
  "PrecipitationInformation/noPrecipitation": "weather.precipitation_type",
  "PrecipitationInformation/precipitationDetail/precipitationType": "weather.precipitation_type",
  "PrecipitationInformation/precipitationDetail/precipitationIntensity":
    "weather.precipitation_rate",
  "PrecipitationInformation/precipitationDetail/precipitationIntensityGrade": null,
  "PrecipitationInformation/precipitationDetail/depositionDepth": null,
  "RoadSurfaceConditionInformation/weatherRelatedRoadConditionType": "road.surface_state",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/roadSurfaceTemperature":
    "road.surface_temperature",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/temperatureBelowOrAboveRoadSurface/temperatureBelowOrAboveRoadSurface":
    "road.subsurface_temperature",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/temperatureBelowOrAboveRoadSurface/heightBelowOrAboveRoadSurface":
    null,
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/protectionTemperature":
    "road.freezing_point",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/friction": "road.friction",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/waterFilmThickness":
    "road.water_film",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/depthOfSnow": "road.snow_depth",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/iceLayerThickness":
    "road.ice_thickness",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/deIcingConcentration":
    "road.salt_concentration",
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/deIcingApplicationRate": null,
  "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/icePercentage": null,
  PressureInformation: null,
  PollutionInformation: null,
};
