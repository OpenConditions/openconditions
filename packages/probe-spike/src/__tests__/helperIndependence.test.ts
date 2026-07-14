import { describe, expect, it } from "vitest";
import {
  assertHelperIndependentForProduction,
  isSameOperator,
  SameOperatorHelperError,
  type AggregatorTopology,
} from "../index.js";

const INDEPENDENT = {
  leader: { operatorId: "org-openconditions", endpoint: "https://leader.example.org/dap" },
  helper: { operatorId: "org-partner-isrg", endpoint: "https://helper.partner.example/dap" },
};

describe("invariant 6: same-operator Helper is test-only", () => {
  it("THROWS in production when Leader and Helper share an operator id", () => {
    const topology: AggregatorTopology = {
      environment: "production",
      leader: { operatorId: "org-openconditions", endpoint: "https://a.example/dap" },
      helper: { operatorId: "org-openconditions", endpoint: "https://b.example/dap" },
    };
    expect(() => assertHelperIndependentForProduction(topology)).toThrow(SameOperatorHelperError);
  });

  it("THROWS in production when Leader and Helper share an endpoint", () => {
    const topology: AggregatorTopology = {
      environment: "production",
      leader: { operatorId: "org-a", endpoint: "https://same.example/dap/" },
      helper: { operatorId: "org-b", endpoint: "https://same.example/dap" },
    };
    expect(() => assertHelperIndependentForProduction(topology)).toThrow(/endpoint/);
  });

  it("THROWS in production when Leader and Helper share an HPKE config id", () => {
    const topology: AggregatorTopology = {
      environment: "production",
      leader: { ...INDEPENDENT.leader, hpkeConfigId: "hpke-1" },
      helper: { ...INDEPENDENT.helper, hpkeConfigId: "hpke-1" },
    };
    expect(() => assertHelperIndependentForProduction(topology)).toThrow(/HPKE/);
  });

  it("PASSES for an independent production topology", () => {
    const topology: AggregatorTopology = { environment: "production", ...INDEPENDENT };
    expect(() => assertHelperIndependentForProduction(topology)).not.toThrow();
    expect(isSameOperator(topology)).toBe(false);
  });

  it("ALLOWS a same-operator Helper in test and staging", () => {
    for (const environment of ["test", "staging"] as const) {
      const topology: AggregatorTopology = {
        environment,
        leader: { operatorId: "org-openconditions", endpoint: "http://localhost:8080" },
        helper: { operatorId: "org-openconditions", endpoint: "http://localhost:8081" },
      };
      expect(() => assertHelperIndependentForProduction(topology)).not.toThrow();
      expect(isSameOperator(topology)).toBe(true);
    }
  });
});
