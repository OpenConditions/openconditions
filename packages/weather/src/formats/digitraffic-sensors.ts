/**
 * How one Digitraffic road weather sensor's value becomes a reading: the
 * property, the unit the publisher states for it, and, for a road-surface
 * value, the channel it is a stream of. Sensor ids and names are Fintraffic's
 * (`/api/weather/v2/sensors`), which keeps them stable across stations.
 */
export interface DigitrafficSensor {
  /** The publisher's sensor id: the value's `id` and an entry of a station's `sensors`. */
  id: number;
  /** The publisher's sensor name, which a value must carry beside its id. */
  name: string;
  property: string;
  /** The unit the publisher states; a value stating another is not read. */
  unit: string;
  /** For a quantity, the property's unit; a category reads `codes` instead. */
  modelUnit?: string;
  /**
   * For a category, the publisher's codes: a vocabulary value, or null for a
   * code that says the sensor can tell nothing (a fault), read as unknown.
   */
  codes?: Readonly<Record<number, string | null>>;
  vocabulary?: string;
  aggregation: "instantaneous" | "mean" | "max";
  /** The span the publisher's sensor description says the value covers. */
  windowSec?: number;
  /**
   * A road-surface value is a stream of the physical sensor that measures it,
   * so numbered sensors stay apart: the sensor (several values share one)
   * and its number where the publisher numbers it.
   */
  channel?: { sensor: string; index?: number };
  /**
   * A value of the solution on the surface (its salt concentration, its
   * freezing point), which a sensor measuring no water film does not have.
   */
  ofSolution?: true;
}

/**
 * KELI (road condition the station infers from a surface sensor): the
 * publisher's descriptions are dry, moist, wet, wet and salty, frost, snow,
 * ice, probably moist and salty, slushy; 0 says the sensor has a fault.
 * KELI_3 and KELI_4 carry no descriptions of their own; their values follow
 * KELI_1's where the station has the sensor. A station also states 0 for a
 * numbered sensor it does not have (it reports nothing else of it): that is
 * no sensor, not a fault. The VAISALA_API station 15038 sends 13, which is
 * outside the table and so dropped as a rejected value.
 */
const KELI: Readonly<Record<number, string | null>> = {
  0: null,
  1: "dry",
  2: "damp",
  3: "wet",
  4: "chemically_wet",
  5: "frost",
  6: "snow",
  7: "ice",
  8: "chemically_wet",
  9: "slush",
};

/**
 * SATEEN_OLOMUOTO_PWDXX (form of precipitation from the present-weather
 * sensor). Ice crystals and snow grains are snow and graupel is hail, as the
 * DATEX II crosswalk reads them; freezing drizzle is freezing rain; very light
 * rain whose form the sensor cannot tell is unknown.
 */
const PWD_PRECIPITATION: Readonly<Record<number, string | null>> = {
  7: "none",
  8: null,
  9: "drizzle",
  10: "rain",
  11: "snow",
  12: "sleet",
  13: "sleet",
  14: "hail",
  15: "snow",
  16: "snow",
  17: "hail",
  18: "freezing_rain",
  19: "freezing_rain",
};

const TEN_MINUTES = 600;

const air = (
  id: number,
  name: string,
  property: string,
  unit: string,
  modelUnit: string,
  over?: Pick<DigitrafficSensor, "aggregation" | "windowSec">,
): DigitrafficSensor => ({
  id,
  name,
  property,
  unit,
  modelUnit,
  aggregation: "instantaneous",
  ...over,
});

const surface = (
  id: number,
  name: string,
  property: string,
  unit: string,
  modelUnit: string | undefined,
  channel: { sensor: string; index?: number },
  ofSolution?: true,
): DigitrafficSensor => ({
  id,
  name,
  property,
  unit,
  ...(modelUnit === undefined ? { codes: KELI, vocabulary: "surface_state" } : { modelUnit }),
  aggregation: "instantaneous",
  channel,
  ...(ofSolution ? { ofSolution } : {}),
});

/**
 * The conductive surface sensors 1 to 4 and their values, by the publisher's
 * id of each. A sensor on a surface without water states a salt concentration
 * and a freezing point of no solution: in the answer of 2026-10-15, readings
 * with no water film gave a freezing point of 0.0 °C beside concentrations up
 * to 570 g/l (saturated salt water freezes near -21 °C), while on wet sensors
 * the two agreed (20 to 50 g/l, -4 °C).
 */
const NUMBERED: readonly {
  name: string;
  ids: readonly [number, number, number, number];
  property: string;
  unit: string;
  modelUnit?: string;
  ofSolution?: true;
}[] = [
  {
    name: "TIE",
    ids: [3, 5, 101, 111],
    property: "road.surface_temperature",
    unit: "°C",
    modelUnit: "Cel",
  },
  // Ground temperature 4 to 7 cm below the surface, under the same sensor.
  {
    name: "MAA",
    ids: [7, 8, 103, 113],
    property: "road.subsurface_temperature",
    unit: "°C",
    modelUnit: "Cel",
  },
  {
    name: "JÄÄTYMISPISTE",
    ids: [10, 11, 104, 114],
    property: "road.freezing_point",
    unit: "°C",
    modelUnit: "Cel",
    ofSolution: true,
  },
  {
    name: "KOSTEUDEN_MÄÄRÄ",
    ids: [50, 51, 198, 199],
    property: "road.water_film",
    unit: "mm",
    modelUnit: "mm",
  },
  // g/l is kg/m³.
  {
    name: "SUOLAN_VÄKEVYYS",
    ids: [54, 55, 202, 203],
    property: "road.salt_concentration",
    unit: "g/l",
    modelUnit: "kg/m3",
    ofSolution: true,
  },
  { name: "KELI", ids: [27, 28, 105, 115], property: "road.surface_state", unit: "***" },
];

/** The optical (DSC) surface sensors 1 and 2, whose names carry the number without a separator. */
const OPTICAL: readonly {
  name: string;
  ids: readonly [number, number];
  property: string;
  unit: string;
  modelUnit: string;
}[] = [
  { name: "KITKA", ids: [176, 186], property: "road.friction", unit: "µ", modelUnit: "1" },
  {
    name: "VEDEN_MÄÄRÄ",
    ids: [177, 187],
    property: "road.water_film",
    unit: "mm",
    modelUnit: "mm",
  },
  {
    name: "LUMEN_MÄÄRÄ",
    ids: [178, 188],
    property: "road.snow_depth",
    unit: "mm",
    modelUnit: "mm",
  },
  {
    name: "JÄÄN_MÄÄRÄ",
    ids: [179, 189],
    property: "road.ice_thickness",
    unit: "mm",
    modelUnit: "mm",
  },
];

/**
 * Every Digitraffic sensor read, in the publisher's id order. Left out:
 * derivatives and differences of values read here (`*_DERIVAATTA`,
 * `KASTEPISTE_ERO_*`, `KUURAPISTE*`), duplicates in another unit
 * (`NÄKYVYYS_KM`, `KITKA*_LUKU`), the station's own forecasts (`*_ENNUSTE`),
 * sliding 24-hour extremes and sums (`ILMAN_LÄMPÖTILA_24H_*`, `SADESUMMA*`),
 * which would share a series with the current value, precipitation grades
 * without a form (`SADE`, `SADE_TILA`) and WMO present-weather codes
 * (`VALLITSEVA_SÄÄ`) where the form sensor is read, values no property holds
 * (air pressure, radiation, warning levels, salt per area, safety
 * temperature, the road body 30 cm down, the optical sensors' own surface
 * classes, `TIENPINNAN_TILA_*`, which the publisher gives no code table),
 * snow depth per lane position beside its mean, and the sensors' and the
 * station's raw signals and statuses.
 */
export const DIGITRAFFIC_SENSORS: readonly DigitrafficSensor[] = [
  air(1, "ILMA", "weather.air_temperature", "°C", "Cel"),
  air(9, "KASTEPISTE", "weather.dew_point", "°C", "Cel"),
  air(16, "KESKITUULI", "weather.wind_speed", "m/s", "m/s", {
    aggregation: "mean",
    windowSec: TEN_MINUTES,
  }),
  air(17, "MAKSIMITUULI", "weather.wind_gust", "m/s", "m/s", {
    aggregation: "max",
    windowSec: TEN_MINUTES,
  }),
  air(18, "TUULENSUUNTA", "weather.wind_direction", "°", "deg", {
    aggregation: "mean",
    windowSec: TEN_MINUTES,
  }),
  air(21, "ILMAN_KOSTEUS", "weather.humidity", "%", "%"),
  // An hourly rate of the last 30 seconds' sliding mean.
  air(23, "SADE_INTENSITEETTI", "weather.precipitation_rate", "mm/h", "mm/h", {
    aggregation: "mean",
    windowSec: 30,
  }),
  {
    id: 25,
    name: "SATEEN_OLOMUOTO_PWDXX",
    property: "weather.precipitation_type",
    unit: "///",
    codes: PWD_PRECIPITATION,
    vocabulary: "precipitation_type",
    aggregation: "instantaneous",
  } satisfies DigitrafficSensor,
  air(58, "NÄKYVYYS_M", "weather.visibility", "m", "m"),
  // A laser's mean snow depth across the road.
  surface(150, "LUMENMITTAUS_KA", "road.snow_depth", "mm", "mm", { sensor: "snow-depth" }),
  // The optical DST111 sensor's surface temperature.
  surface(172, "TIEN_LÄMPÖTILA_DST-ANT", "road.surface_temperature", "°C", "Cel", {
    sensor: "dst",
  }),
  ...NUMBERED.flatMap((family) =>
    family.ids.map((id, i) =>
      surface(
        id,
        `${family.name}_${i + 1}`,
        family.property,
        family.unit,
        family.modelUnit,
        { sensor: `surface-${i + 1}`, index: i + 1 },
        family.ofSolution,
      ),
    ),
  ),
  ...OPTICAL.flatMap((family) =>
    family.ids.map((id, i) =>
      surface(id, `${family.name}${i + 1}`, family.property, family.unit, family.modelUnit, {
        sensor: `optical-${i + 1}`,
        index: i + 1,
      }),
    ),
  ),
].sort((a, b) => a.id - b.id);

/** The sensors read, by the publisher's id. */
export const DIGITRAFFIC_SENSOR_BY_ID: ReadonlyMap<number, DigitrafficSensor> = new Map(
  DIGITRAFFIC_SENSORS.map((sensor) => [sensor.id, sensor]),
);
