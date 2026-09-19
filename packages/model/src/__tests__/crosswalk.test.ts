import { describe, expect, it } from "vitest";
import { kernelModule } from "../kernel/module.js";
import { buildRegistry, RegistryError } from "../registry/build.js";
import {
  buildCrosswalk,
  CrosswalkError,
  parseSituationCode,
  situationCode,
} from "../registry/crosswalk.js";
import { defineKind, extendVocabulary, type RegistryModule } from "../registry/define.js";
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
