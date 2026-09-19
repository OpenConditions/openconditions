import { describe, expect, it } from "vitest";
import { Result } from "../kernel/result.js";
import { vehicleSchemas } from "../kernel/vehicle.js";
import { anyVocab } from "../kernel/vocab.js";

const { VehicleApplicability, VehicleSelector } = vehicleSchemas(anyVocab);
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("vehicle applicability", () => {
  it("needs include for classes and nothing else", () => {
    expect(ok(VehicleApplicability, { kind: "classes" })).toBe(false);
    expect(ok(VehicleApplicability, { kind: "all", include: [{ class: "car" }] })).toBe(false);
    expect(
      ok(VehicleApplicability, { kind: "all", except: [{ usage: "emergency_services" }] }),
    ).toBe(true);
    expect(ok(VehicleApplicability, { kind: "classes", include: [{ class: "truck" }] })).toBe(true);
    expect(ok(VehicleApplicability, { kind: "unknown", raw: ["LKW über 7,5 t"] })).toBe(true);
  });

  it("requires a selector to constrain something besides raw", () => {
    expect(ok(VehicleSelector, { raw: ["LKW"] })).toBe(false);
    expect(ok(VehicleSelector, { class: "truck", raw: ["LKW"] })).toBe(true);
  });

  it("holds dimensions to one canonical unit", () => {
    const heavier = (unit: string, value: number) => ({
      class: "truck",
      when: [{ dimension: "gross_weight", operator: "gt", value: { value, unit } }],
    });
    expect(ok(VehicleSelector, heavier("kg", 7500))).toBe(true);
    expect(ok(VehicleSelector, heavier("t", 7.5))).toBe(false);
    const axles = {
      when: [{ dimension: "axle_count", operator: "gte", value: { value: 3, unit: "1" } }],
    };
    expect(ok(VehicleSelector, axles)).toBe(true);
  });
});

describe("results", () => {
  it("keeps unknown and not_applicable distinct from values", () => {
    expect(ok(Result, { type: "unknown" })).toBe(true);
    expect(ok(Result, { type: "not_applicable" })).toBe(true);
    expect(ok(Result, { type: "unknown", value: 1 })).toBe(false);
  });

  it("carries money as a decimal string", () => {
    expect(ok(Result, { type: "money", amount: "1.799", currency: "EUR", per: "L" })).toBe(true);
    expect(ok(Result, { type: "money", amount: 1.799, currency: "EUR" })).toBe(false);
  });
});
