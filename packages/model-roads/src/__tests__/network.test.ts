import { describe, expect, it } from "vitest";
import { feature, m, ok, registry } from "./network-drafts.js";

describe("structures", () => {
  const tunnel = feature(
    "structure",
    "78743990",
    {
      clearances: [
        { road: "carried", height: m(4.6), basis: "measured", position: "left" },
        { road: "carried", height: m(4.8), basis: "measured", position: "centre" },
        { road: "carried", height: m(4.2), basis: "calculated" },
        { road: "carried", height: m(4.2), basis: "signed" },
      ],
      width: m(6.5),
    },
    { type: "tunnel", name: [{ lang: "nb", text: "Gudvangatunnelen" }] },
  );

  it("keeps every clearance a register publishes, with how it was obtained", () => {
    expect(ok(tunnel)).toBe(true);
  });

  it("holds heights to metres", () => {
    const feet = {
      ...tunnel,
      details: {
        ...tunnel.details,
        clearances: [{ road: "carried", height: { value: 14, unit: "[ft_i]" }, basis: "signed" }],
      },
    };
    expect(registry.validateDraft(feet).ok).toBe(false);
  });

  it("keeps the inventory's own codes for a US bridge", () => {
    const bridge = feature(
      "structure",
      "DC-00000000001",
      {
        carries: "I-295",
        crosses: "KENILWORTH AVE",
        yearBuilt: 1961,
        clearances: [{ road: "crossed", height: m(4.39), basis: "measured" }],
        nbi: {
          structureNumber: "00000000001",
          stateCode: "11",
          openStatus: "P",
          postingEvaluation: "4",
          conditions: { deck: "6", superstructure: "5", substructure: "6", culvert: "N" },
        },
      },
      { type: "bridge" },
    );
    expect(ok(bridge)).toBe(true);
  });
});

describe("rail crossings, blackspots and roadside devices", () => {
  it("describes a level crossing by its position, barriers and warnings", () => {
    const crossing = feature("rail_crossing", "140762P", {
      position: "at_grade",
      barrier: "half",
      warnings: ["flashing_lights", "bells"],
      tracks: 2,
      usage: "road",
    });
    expect(ok(crossing)).toBe(true);
    expect(
      registry.validateDraft({ ...crossing, details: { ...crossing.details, position: "level" } })
        .ok,
    ).toBe(false);
  });

  it("counts a blackspot's accidents by their worst outcome", () => {
    const spot = feature("blackspot", "N16LM_015.0", {
      period: { from: "2014-01-01", to: "2016-12-31" },
      accidents: 6,
      bySeverity: { fatal: 1, serious: 0, slight: 2, injury: 3, damageOnly: 3 },
      rate: { value: 114.52, basis: "injury collisions per 100 million vehicle-km" },
      band: "Twice Above Average Rate",
    });
    expect(ok(spot)).toBe(true);
  });

  it("registers emergency phones and lane-control gantries, the gantry as a field device", () => {
    expect(ok(feature("emergency_phone", "sos-1", {}))).toBe(true);
    expect(registry.kind("feature", "lane_control_gantry")?.traits).toEqual(["field_device"]);
  });

  it("keeps the kind registered for a value the source says exists but does not publish", () => {
    expect(registry.vocabulary("issue_code")?.values).toContain("value_not_published");
  });
});
