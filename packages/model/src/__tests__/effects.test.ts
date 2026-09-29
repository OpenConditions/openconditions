import { describe, expect, it } from "vitest";
import { closure, registry } from "./fixtures.js";

const k = registry.kernel;

describe("effects", () => {
  const effect = (e: Record<string, unknown>) => k.Effect.safeParse(e);

  it("requires issues and normalization unsupported on an unsupported effect", () => {
    const base = {
      id: "x/unsupported",
      kind: "unsupported",
      v: 1,
      applicability: { kind: "unknown" },
      compliance: "unknown",
    };
    expect(effect({ ...base, normalization: "partial" }).success).toBe(false);
    expect(effect({ ...base, normalization: "unsupported" }).success).toBe(false);
    expect(
      effect({
        ...base,
        normalization: "unsupported",
        issues: [{ code: "unsupported_type", sourcePath: "a.b" }],
      }).success,
    ).toBe(true);
  });

  it("holds dimensions to one canonical unit", () => {
    const limit = {
      id: "x/dimension_limit",
      kind: "dimension_limit",
      v: 1,
      dimension: "gross_weight",
      operator: "lte",
      meaning: "maximum_permitted",
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
    };
    expect(effect({ ...limit, value: { value: 7500, unit: "kg" } }).success).toBe(true);
    expect(effect({ ...limit, value: { value: 7.5, unit: "t" } }).success).toBe(false);
    const truckAbove = {
      kind: "classes",
      include: [
        {
          class: "truck",
          when: [{ dimension: "height", operator: "gt", value: { value: 4, unit: "ft" } }],
        },
      ],
    };
    expect(effect({ ...closure("x/closure"), applicability: truckAbove }).success).toBe(false);
  });

  it("tells a legal limit from a measured clearance", () => {
    const height = {
      id: "x/dimension_limit",
      kind: "dimension_limit",
      v: 1,
      dimension: "height",
      operator: "lte",
      value: { value: 4.35, unit: "m" },
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
    };
    expect(effect({ ...height, meaning: "maximum_permitted" }).success).toBe(true);
    expect(effect({ ...height, meaning: "physical_limit" }).success).toBe(true);
    expect(effect({ ...height, meaning: "advisory" }).success).toBe(false);
  });

  it("needs include for classes applicability and nothing else", () => {
    expect(effect({ ...closure("a"), applicability: { kind: "classes" } }).success).toBe(false);
    expect(
      effect({ ...closure("a"), applicability: { kind: "all", include: [{ class: "car" }] } })
        .success,
    ).toBe(false);
    expect(
      effect({
        ...closure("a"),
        applicability: { kind: "all", except: [{ usage: "emergency_services" }] },
      }).success,
    ).toBe(true);
    expect(
      effect({ ...closure("a"), applicability: { kind: "classes", include: [{ raw: ["LKW"] }] } })
        .success,
    ).toBe(false);
  });

  it("checks the variant's own version and unit rules", () => {
    expect(effect({ ...closure("a"), v: 2 }).success).toBe(false);
    const speed = {
      ...closure("a"),
      kind: "speed_limit",
      scope: undefined,
      limit: { value: 80, unit: "km/h" },
    };
    delete (speed as Record<string, unknown>)["scope"];
    expect(effect(speed).success).toBe(true);
    expect(effect({ ...speed, limit: { value: 50, unit: "[mi_i]/h" } }).success).toBe(false);
  });
});
