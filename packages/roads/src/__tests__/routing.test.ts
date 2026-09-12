import { describe, expect, it } from "vitest";
import { normalizeVehicleApplicability } from "../routing.js";
import { restrictionDetails } from "./fixtures/restriction-event.js";

describe("normalizeVehicleApplicability", () => {
  it("treats an absent selector as unrestricted", () => {
    expect(normalizeVehicleApplicability(undefined)).toEqual({ kind: "all" });
  });

  it("maps supported DATEX and WZDx vehicle terms to canonical classes", () => {
    expect(
      normalizeVehicleApplicability(["passengerCar", "heavyGoodsVehicle", "publicTransport"]),
    ).toEqual({
      kind: "classes",
      classes: ["car", "truck", "bus"],
      raw: ["passengerCar", "heavyGoodsVehicle", "publicTransport"],
    });
  });

  it("keeps negated and unknown predicates fail-closed with the raw terms", () => {
    expect(normalizeVehicleApplicability(["except buses"])).toEqual({
      kind: "unknown",
      raw: ["except buses"],
    });
    expect(normalizeVehicleApplicability(["agriculturalVehicle"])).toEqual({
      kind: "unknown",
      raw: ["agriculturalVehicle"],
    });
  });

  it("does not widen a dimension-qualified vehicle scope to its broad class", () => {
    expect(
      normalizeVehicleApplicability(
        ["lorry"],
        [{ type: "height", value: 4.5, unit: "m", operator: "greaterThan" }],
      ),
    ).toMatchObject({ kind: "unknown" });
  });
});

describe("normalizeVehicleApplicability restriction carrier", () => {
  it("does not widen a restriction when the legacy array is absent", () => {
    expect(
      normalizeVehicleApplicability(undefined, undefined, {
        restrictionDetails: { schemaVersion: 9 },
      }).kind,
    ).toBe("unknown");
    expect(normalizeVehicleApplicability(undefined, undefined, {}).kind).toBe("all");
  });

  it("stays unknown for a valid envelope, an unsupported marker and an all-vehicle claim", () => {
    expect(
      normalizeVehicleApplicability(undefined, undefined, {
        restrictionDetails: restrictionDetails(),
      }),
    ).toEqual({ kind: "unknown", raw: ["normalized_restriction_details"] });
    expect(
      normalizeVehicleApplicability(undefined, undefined, {
        restrictionDetailsUnsupported: true,
      }).kind,
    ).toBe("unknown");
    expect(
      normalizeVehicleApplicability(["all"], undefined, {
        restrictionDetails: restrictionDetails(),
      }).kind,
    ).toBe("unknown");
  });

  it("keeps existing two-argument behaviour unchanged", () => {
    expect(normalizeVehicleApplicability(["passengerCar"]).kind).toBe("classes");
  });
});
