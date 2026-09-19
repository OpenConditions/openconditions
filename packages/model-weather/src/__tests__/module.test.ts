import { buildRegistry, kernelModule } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import {
  DATEX2_MEASURED_WEATHER,
  DATEX2_PRECIPITATION_TYPES,
  DATEX2_ROAD_CONDITIONS,
} from "../crosswalk/datex2.js";
import { weatherModule } from "../module.js";
import { DATEX2_V2_WEATHER, DATEX2_V3_WEATHER } from "../vocabularies/datex2.js";

const registry = buildRegistry([kernelModule, weatherModule]);
type Table = Readonly<Record<string, string | null>>;
const mapped = (table: Table) => Object.values(table).filter((v): v is string => v !== null);
const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];

describe("weather module", () => {
  it("builds on the kernel alone", () => {
    expect(registry.kind("feature", "weather_station")?.domain).toBe("weather");
    expect(registry.properties().every((p) => p.domain === "weather")).toBe(true);
  });

  it("keeps compass bearings out of hourly means", () => {
    expect(registry.property("weather.wind_direction")?.retention).toEqual({ rawDays: 7 });
    expect(registry.property("weather.wind_speed")?.retention?.rollup).toEqual({
      period: "hourly",
    });
  });

  it("measures salt concentration as mass per volume", () => {
    expect(registry.property("road.salt_concentration")?.result).toEqual({
      type: "quantity",
      unit: "kg/m3",
    });
  });
});

describe("weather crosswalk coverage", () => {
  it.each([
    [
      "precipitation_type",
      DATEX2_PRECIPITATION_TYPES,
      union(DATEX2_V3_WEATHER.precipitationTypes, DATEX2_V2_WEATHER.precipitationTypes),
    ],
    [
      "surface_state",
      DATEX2_ROAD_CONDITIONS,
      union(DATEX2_V3_WEATHER.roadConditionTypes, DATEX2_V2_WEATHER.roadConditionTypes),
    ],
  ] as const)("maps every DATEX value of both versions to %s", (vocabulary, table, values) => {
    expect(values.filter((v) => !(v in table))).toEqual([]);
    expect(Object.keys(table).filter((k) => !values.includes(k))).toEqual([]);
    const registered = registry.vocabulary(vocabulary)!.values;
    expect(mapped(table).filter((v) => !registered.includes(v))).toEqual([]);
  });

  it("covers every DATEX weather measured value of both versions", () => {
    const leaves = new Set<string>();
    for (const v of [DATEX2_V3_WEATHER, DATEX2_V2_WEATHER]) {
      for (const [cls, paths] of Object.entries(v.measuredValues)) {
        for (const p of paths) leaves.add(`${cls}/${p}`);
      }
    }
    const covered = (leaf: string) =>
      leaf in DATEX2_MEASURED_WEATHER || leaf.split("/")[0]! in DATEX2_MEASURED_WEATHER;
    expect([...leaves].filter((l) => !covered(l))).toEqual([]);
    const known = (key: string) =>
      leaves.has(key) || [...leaves].some((l) => l.startsWith(`${key}/`));
    expect(Object.keys(DATEX2_MEASURED_WEATHER).filter((k) => !known(k))).toEqual([]);
    expect(mapped(DATEX2_MEASURED_WEATHER).filter((p) => !registry.property(p))).toEqual([]);
  });

  it("resolves measured values and states through the crosswalk", () => {
    expect(
      registry.crosswalk.property(
        "datex2_v3",
        "RoadSurfaceConditionInformation/roadSurfaceConditionMeasurements/friction",
      ),
    ).toBe("road.friction");
    expect(registry.crosswalk.value("precipitation_type", "datex2_v3", "icePellets")).toBe("sleet");
    expect(registry.crosswalk.value("surface_state", "datex2_v2", "slipperyRoad")).toBeUndefined();
  });
});
