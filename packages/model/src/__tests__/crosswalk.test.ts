import { describe, expect, it } from "vitest";
import { kernelModule } from "../kernel/module.js";
import { buildRegistry, RegistryError } from "../registry/build.js";
import {
  buildCrosswalk,
  CrosswalkError,
  featureCode,
  parseSituationCode,
  situationCode,
} from "../registry/crosswalk.js";
import {
  defineKind,
  defineProperty,
  extendVocabulary,
  type RegistryModule,
} from "../registry/define.js";
import { testModule } from "./fixtures.js";

const incident = defineKind({
  class: "situation",
  code: "incident",
  domain: "roads",
  version: "1.0",
  description: "incident with crosswalks",
  types: { accident: ["overturned"], breakdown: [] },
  details: () => ({}),
  mappings: { road511: ["incident"] },
  typeMappings: {
    accident: { datex2_v3: ["Accident"], gtfs_rt: ["ACCIDENT"], traff: ["INCIDENT_ACCIDENT"] },
    "accident.overturned": { datex2_v2: ["Accident:overturnedVehicle"] },
    breakdown: { datex2_v3: ["VehicleObstruction:brokenDownVehicle"], gtfs_rt: ["OTHER_CAUSE"] },
  },
});
const causes = extendVocabulary({
  vocabulary: "cause",
  values: [],
  valueMappings: { accident: { datex2_v3: ["accident"], gtfs_rt: ["ACCIDENT"] } },
});

describe("buildCrosswalk", () => {
  const cw = buildCrosswalk([incident, causes]);

  it("resolves source codes to the most specific classification", () => {
    expect(cw.situation("datex2_v3", "Accident")).toEqual({ kind: "incident", type: "accident" });
    expect(cw.situation("datex2_v2", "Accident:overturnedVehicle")).toEqual({
      kind: "incident",
      type: "accident",
      subtype: "overturned",
    });
    expect(cw.situation("datex2_v3", "Roadworks")).toBeUndefined();
    expect(cw.value("cause", "datex2_v3", "accident")).toBe("accident");
  });

  it("resolves an emitter code from the subtype up to the kind", () => {
    const overturned = { kind: "incident", type: "accident", subtype: "overturned" };
    expect(cw.situationTargetCode("traff", overturned)).toBe("INCIDENT_ACCIDENT");
    expect(cw.situationTargetCode("road511", overturned)).toBe("incident");
    expect(cw.situationTargetCode("gtfs_rt", { kind: "incident", type: "breakdown" })).toBe(
      "OTHER_CAUSE",
    );
    expect(cw.valueTargetCode("cause", "gtfs_rt", "accident")).toBe("ACCIDENT");
  });

  it("lets emitter codes repeat but rejects a parsed code mapped twice", () => {
    const twice = defineKind({
      ...incident,
      typeMappings: {
        accident: { datex2_v3: ["Accident"] },
        breakdown: { datex2_v3: ["Accident"] },
      },
    });
    expect(() => buildCrosswalk([twice])).toThrow(CrosswalkError);
  });

  it("rejects a mapping for an unregistered type", () => {
    const wrong = defineKind({ ...incident, typeMappings: { fire: { wzdx: ["x"] } } });
    expect(() => buildCrosswalk([wrong])).toThrow(/"fire" is not registered/);
  });
});

describe("feature and property crosswalks", () => {
  const sign = defineKind({
    class: "feature",
    code: "vms",
    domain: "roads",
    version: "1.0",
    description: "sign",
    types: { matrix: [], arrow_board: [] },
    details: () => ({}),
    mappings: { osm: ["highway=variable_message_sign"] },
    typeMappings: {
      matrix: { datex2_v3: ["vmsType:colourGraphic"], wzdx: ["device_type:dynamic-message-sign"] },
      arrow_board: { wzdx: ["device_type:arrow-board"] },
    },
  });
  const speed = defineProperty({
    code: "traffic.speed",
    domain: "roads",
    version: "1.0",
    description: "speed",
    result: { type: "quantity", unit: "km/h" },
    subjects: [{ kind: "segments" }],
    mappings: { datex2_v3: ["TrafficSpeed/averageVehicleSpeed", "TrafficSpeed/maximumSpeed"] },
  });
  const cw = buildCrosswalk([sign, speed]);

  it("resolves source codes to feature classifications and properties", () => {
    expect(cw.feature("datex2_v3", "vmsType:colourGraphic")).toEqual({
      kind: "vms",
      type: "matrix",
    });
    expect(cw.feature("wzdx", "device_type:arrow-board")).toEqual({
      kind: "vms",
      type: "arrow_board",
    });
    expect(cw.feature("wzdx", "device_type:camera")).toBeUndefined();
    expect(cw.property("datex2_v3", "TrafficSpeed/maximumSpeed")).toBe("traffic.speed");
    expect(cw.propertyTargetCode("datex2_v3", "traffic.speed")).toBe(
      "TrafficSpeed/averageVehicleSpeed",
    );
  });

  it("falls back from the type's emitter code to the kind's", () => {
    expect(cw.featureTargetCode("osm", { kind: "vms", type: "matrix" })).toBe(
      "highway=variable_message_sign",
    );
    expect(featureCode({ kind: "vms", type: "matrix" })).toBe("vms.matrix");
  });

  it("rejects an ingest code mapped to two properties", () => {
    const volume = defineProperty({
      ...speed,
      code: "traffic.volume",
      mappings: { datex2_v3: ["TrafficSpeed/maximumSpeed"] },
    });
    expect(() => buildCrosswalk([speed, volume])).toThrow(/mapped twice/);
  });
});

describe("registry crosswalks", () => {
  const withCrosswalk: RegistryModule = {
    name: "crosswalk",
    entries: [causes],
  };

  it("merges value mappings from every module", () => {
    const registry = buildRegistry([kernelModule, testModule, withCrosswalk]);
    expect(registry.vocabulary("cause")!.valueMappings["accident"]).toEqual({
      datex2_v3: ["accident"],
      gtfs_rt: ["ACCIDENT"],
    });
    expect(registry.crosswalk.value("cause", "datex2_v3", "accident")).toBe("accident");
  });

  it("pools two modules' codes for one shared value and emits each enumeration's own", () => {
    const trend = (name: string, enumeration: string, word: string, value: string) => ({
      name,
      entries: [
        extendVocabulary({
          vocabulary: "trend",
          values: [],
          valueMappings: { [value]: { datex2_v3: [`${enumeration}:${word}`] } },
        }),
      ],
    });
    const registry = buildRegistry([
      kernelModule,
      testModule,
      trend("parking", "parkingOccupancyTrend", "stable", "steady"),
      trend("roads", "travelTimeTrendType", "stable", "steady"),
    ]);
    const cw = registry.crosswalk;
    expect(cw.value("trend", "datex2_v3", "parkingOccupancyTrend:stable")).toBe("steady");
    expect(cw.value("trend", "datex2_v3", "travelTimeTrendType:stable")).toBe("steady");
    expect(cw.valueTargetCode("trend", "datex2_v3", "steady", "travelTimeTrendType")).toBe(
      "travelTimeTrendType:stable",
    );
    expect(cw.valueTargetCode("trend", "datex2_v3", "steady", "parkingOccupancyTrend")).toBe(
      "parkingOccupancyTrend:stable",
    );
    // An enumeration with no code for the value emits nothing, never another list's code.
    expect(cw.valueTargetCode("trend", "datex2_v3", "steady", "occupancyTrend")).toBeUndefined();
  });

  it("still rejects one code mapped to a shared value by two modules", () => {
    const same = (name: string): RegistryModule => ({
      name,
      entries: [
        extendVocabulary({
          vocabulary: "trend",
          values: [],
          valueMappings: { steady: { datex2_v3: ["stable"] } },
        }),
      ],
    });
    expect(() => buildRegistry([kernelModule, testModule, same("a"), same("b")])).toThrow(
      RegistryError,
    );
  });

  it("rejects mappings for a value the vocabulary lacks", () => {
    const bad: RegistryModule = {
      name: "bad",
      entries: [
        extendVocabulary({
          vocabulary: "cause",
          values: [],
          valueMappings: { meteor: { datex2_v3: ["meteor"] } },
        }),
      ],
    };
    expect(() => buildRegistry([kernelModule, testModule, bad])).toThrow(RegistryError);
  });
});

describe("situation codes", () => {
  it("round-trips kind.type.subtype", () => {
    expect(parseSituationCode("incident.accident.overturned")).toEqual({
      kind: "incident",
      type: "accident",
      subtype: "overturned",
    });
    expect(situationCode({ kind: "closure", type: "closure" })).toBe("closure.closure");
    expect(() => parseSituationCode("incident")).toThrow(TypeError);
    expect(() => parseSituationCode("a.b.c.d")).toThrow(TypeError);
  });
});
