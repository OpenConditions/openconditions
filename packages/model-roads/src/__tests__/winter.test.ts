import { describe, expect, it } from "vitest";
import { feature, m, observation, ok, registry } from "./network-drafts.js";

describe("passes and chain controls", () => {
  const pass = feature("mountain_pass", "79210537", {
    elevation: m(1434),
    gradientPct: 10,
    winterClosure: { from: "12-01", to: "05-01" },
    nightClosure: { from: "11-01", to: "05-05" },
    closedDaysPerYear: 188,
  });

  it("keeps a pass's normal-year closures as seasonal windows", () => {
    expect(ok(pass)).toBe(true);
    const badDay = {
      ...pass,
      details: { ...pass.details, winterClosure: { from: "12-32", to: "05-01" } },
    };
    expect(registry.validateDraft(badDay).ok).toBe(false);
  });

  it("observes a pass's status per direction when the source splits it", () => {
    const status = (direction?: string) =>
      observation(
        pass,
        "pass.status",
        { type: "category", value: "open", vocabulary: "pass_status" },
        direction === undefined ? undefined : { direction },
      );
    expect(ok(status("N"))).toBe(true);
    expect(ok(status())).toBe(true);
    expect(registry.validateDraft(status("Northbound")).ok).toBe(false);
  });

  it("observes chain levels on chain-control zones and passes only", () => {
    const zone = feature("chain_control_zone", "3-ALP-89-23.6-N-237", {});
    const level = (subject: { id: string }) =>
      observation(subject, "winter.chain_level", {
        type: "category",
        value: "R2",
        vocabulary: "chain_level",
      });
    expect(ok(zone)).toBe(true);
    expect(ok(level(zone))).toBe(true);
    expect(ok(level(pass))).toBe(true);
    expect(registry.property("winter.chain_level")?.routingRelevant).toBe(true);
  });
});
