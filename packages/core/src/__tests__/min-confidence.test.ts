import { describe, expect, it } from "vitest";
import { minConfidenceClause } from "../observations.js";

function clause(min: "low" | "nominal" | "high") {
  const params: unknown[] = [];
  const sql = minConfidenceClause("l", min, (value) => {
    params.push(value);
    return `$${params.length}`;
  });
  return { sql, params };
}

describe("minConfidenceClause", () => {
  it("leaves out nothing for low", () => {
    expect(clause("low")).toEqual({ sql: undefined, params: [] });
  });

  it("drops a fraction below 0.3 and the VIIRS low codes for nominal", () => {
    const { sql, params } = clause("nominal");
    expect(params).toEqual([0.3, ["low", "l"]]);
    expect(sql).toContain("l.reading #>> '{quality,confidence}'");
    expect(sql).toContain("lower(l.reading #>> '{quality,supplierCode}')");
    // A reading that states no confidence compares to NULL, which IS NOT TRUE keeps.
    expect(sql?.match(/IS NOT TRUE/g)).toHaveLength(2);
  });

  it("drops a fraction below 0.8 and the low and nominal codes for high", () => {
    expect(clause("high").params).toEqual([0.8, ["low", "l", "nominal", "n"]]);
  });
});
