import { describe, expect, it } from "vitest";
import {
  inClassPaths,
  vocabularyCrosswalk,
  withFeatureCrosswalks,
  withPropertyCrosswalks,
  withSituationCrosswalks,
} from "../registry/crosswalk-tables.js";
import { defineKind, defineProperty } from "../registry/define.js";

const incident = defineKind({
  class: "situation",
  code: "incident",
  domain: "roads",
  version: "1.0",
  description: "x",
  types: { accident: ["overturned"] },
  details: () => ({}),
});
const sign = defineKind({
  class: "feature",
  code: "vms",
  domain: "roads",
  version: "1.0",
  description: "x",
  types: { matrix: [] },
  details: () => ({}),
});
const speed = defineProperty({
  code: "traffic.speed",
  domain: "roads",
  version: "1.0",
  description: "x",
  result: { type: "quantity", unit: "km/h" },
  subjects: [{ kind: "segments" }],
});

describe("crosswalk tables", () => {
  it("turns situation tables into type mappings, skipping nulls and excluded codes", () => {
    const [kind] = withSituationCrosswalks(
      [incident],
      [
        {
          target: "datex2_v3",
          table: { Accident: "incident.accident", "Accident:x": null, Old: "incident.accident" },
          include: (code) => code !== "Old",
        },
      ],
      [{ target: "traff", table: { "incident.accident.overturned": "INCIDENT_ACCIDENT" } }],
    );
    expect(kind!.typeMappings).toEqual({
      accident: { datex2_v3: ["Accident"] },
      "accident.overturned": { traff: ["INCIDENT_ACCIDENT"] },
    });
  });

  it("puts kind-level feature codes in mappings and finer ones in type mappings", () => {
    const [kind] = withFeatureCrosswalks(
      [sign],
      [{ target: "wzdx", table: { "device_type:dynamic-message-sign": "vms.matrix", x: "vms" } }],
      [],
    );
    expect(kind!.mappings).toEqual({ wzdx: ["x"] });
    expect(kind!.typeMappings).toEqual({ matrix: { wzdx: ["device_type:dynamic-message-sign"] } });
  });

  it("attaches measured-value codes to properties", () => {
    const [property] = withPropertyCrosswalks(
      [speed],
      [{ target: "datex2_v2", table: { "TrafficSpeed/averageVehicleSpeed": "traffic.speed" } }],
      [],
    );
    expect(property!.mappings).toEqual({ datex2_v2: ["TrafficSpeed/averageVehicleSpeed"] });
  });

  it("builds mapping-only vocabulary extensions", () => {
    expect(
      vocabularyCrosswalk(
        "los",
        [{ target: "datex2_v3", table: { freeFlow: "free_flow", other: null } }],
        [],
      ),
    ).toEqual({
      entry: "vocabulary_extension",
      vocabulary: "los",
      values: [],
      valueMappings: { free_flow: { datex2_v3: ["freeFlow"] } },
    });
  });

  it("matches class and class/path codes against per-class path lists", () => {
    const include = inClassPaths({ TrafficSpeed: ["averageVehicleSpeed"], TrafficGap: [] });
    expect(include("TrafficSpeed/averageVehicleSpeed")).toBe(true);
    expect(include("TrafficSpeed/minimumSpeed")).toBe(false);
    expect(include("TrafficGap")).toBe(true);
    expect(include("TrafficHeadway")).toBe(false);
  });
});
