import { describe, expect, it } from "vitest";
import { federationEligible, historyEligible, isOnDemand } from "../kernel/access.js";
import { draftBase, incidentDraft, registry } from "./fixtures.js";

const onDemand = <T extends { provenance: object; freshness: object }>(draft: T) => ({
  ...draft,
  provenance: { ...draft.provenance, accessMode: "on_demand" },
  freshness: { ...draft.freshness, expiresAt: "2026-09-18T10:15:00Z" },
});

describe("access modes", () => {
  it("accepts an on-demand record that says when its answer goes stale", () => {
    expect(registry.validateDraft(onDemand(incidentDraft())).ok).toBe(true);
  });

  it("rejects an on-demand record without an expiry", () => {
    const draft = onDemand(incidentDraft());
    const result = registry.validateDraft({
      ...draft,
      freshness: draftBase("situation", "x").freshness,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.path.join("."))).toContain("freshness.expiresAt");
    }
  });

  it("keeps on-demand answers out of federation and out of history", () => {
    const record = onDemand(incidentDraft());
    expect(isOnDemand(record)).toBe(true);
    expect(federationEligible(record)).toBe(false);
    expect(historyEligible(record)).toBe(false);
  });

  it("federates a bulk record and keeps its history", () => {
    const record = incidentDraft();
    expect(isOnDemand(record)).toBe(false);
    expect(federationEligible(record)).toBe(true);
    expect(historyEligible(record)).toBe(true);
  });

  it("never federates a fused row, which is this instance's own opinion", () => {
    const fused = {
      provenance: { accessMode: "bulk", sourceId: "@fused" },
    };
    expect(federationEligible(fused)).toBe(false);
    expect(historyEligible(fused)).toBe(true);
  });
});
