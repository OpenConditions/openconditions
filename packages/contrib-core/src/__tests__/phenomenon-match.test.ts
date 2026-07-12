import { describe, expect, it } from "vitest";
import { matchPhenomenonCandidates } from "../phenomenon-match.js";
import type { PhenomenonCandidate } from "../phenomenon-match.js";

function pointNear(meters: number, bearingLon = true): [number, number] {
  // ~1 m ≈ 0.000009° of latitude; offset from a fixed anchor.
  const deg = meters * 0.000009;
  return bearingLon ? [6.5 + deg, 52.0] : [6.5, 52.0 + deg];
}

function makeCandidate(overrides: Partial<PhenomenonCandidate> = {}): PhenomenonCandidate {
  return {
    id: "cand-1",
    domain: "roads",
    type: "hazard",
    geometry: { type: "Point", coordinates: [6.5, 52.0] },
    validFrom: "2026-07-10T12:00:00Z",
    actor: { keyId: "key-b", source: "crowd" },
    status: "active",
    ...overrides,
  };
}

const target: PhenomenonCandidate = {
  id: "target-1",
  domain: "roads",
  type: "hazard",
  geometry: { type: "Point", coordinates: [6.5, 52.0] },
  validFrom: "2026-07-10T12:00:00Z",
  attributes: { fuzziness: "start_unknown" },
  actor: { keyId: "key-a", source: "crowd" },
  status: "active",
};

function decisionFor(
  candidate: PhenomenonCandidate,
  from: PhenomenonCandidate = target
): { compatible: boolean; reasons: string[] } {
  const [d] = matchPhenomenonCandidates(from, [candidate]);
  return { compatible: d!.compatible, reasons: d!.reasons };
}

describe("matchPhenomenonCandidates", () => {
  it("the jam scenario — two crowd reports, same type, 150 m apart, 4 min apart, distinct keys → compatible", () => {
    const jam = makeCandidate({
      id: "cand-jam",
      geometry: { type: "Point", coordinates: pointNear(150, false) },
      validFrom: "2026-07-10T12:04:00Z",
      attributes: { fuzziness: "end_unknown" },
      actor: { keyId: "key-b", source: "crowd" },
    });
    const { compatible, reasons } = decisionFor(jam);
    expect(compatible).toBe(true);
    expect(reasons).toEqual([]);
  });

  it("maps each candidate to a decision keyed by candidate id", () => {
    const decisions = matchPhenomenonCandidates(target, [
      makeCandidate({ id: "a" }),
      makeCandidate({ id: "b" }),
    ]);
    expect(decisions.map((d) => d.candidateId)).toEqual(["a", "b"]);
  });

  it("names a domain mismatch", () => {
    const { compatible, reasons } = decisionFor(makeCandidate({ domain: "transit" }));
    expect(compatible).toBe(false);
    expect(reasons).toContain("domain-mismatch");
  });

  it("names a type mismatch", () => {
    const { compatible, reasons } = decisionFor(makeCandidate({ type: "roadwork" }));
    expect(compatible).toBe(false);
    expect(reasons).toContain("type-mismatch");
  });

  it("names a centroid distance over the 250 m cap (300 m apart)", () => {
    const far = makeCandidate({
      geometry: { type: "Point", coordinates: pointNear(300, false) },
    });
    const { compatible, reasons } = decisionFor(far);
    expect(compatible).toBe(false);
    expect(reasons).toContain("centroid-distance-exceeds-max");
  });

  it("names a validFrom delta over the 900 s cap (20 min apart)", () => {
    const late = makeCandidate({ validFrom: "2026-07-10T12:20:00Z" });
    const { compatible, reasons } = decisionFor(late);
    expect(compatible).toBe(false);
    expect(reasons).toContain("valid-from-delta-exceeds-max");
  });

  it("names a missing validFrom on either side", () => {
    expect(decisionFor(makeCandidate({ validFrom: undefined })).reasons).toContain(
      "valid-from-missing"
    );
    const targetNoValidFrom: PhenomenonCandidate = { ...target, validFrom: undefined };
    expect(decisionFor(makeCandidate(), targetNoValidFrom).reasons).toContain("valid-from-missing");
  });

  it("names a legacy/locale-shaped validFrom as invalid instead of legacy-parsing it", () => {
    for (const legacy of ["07/10/2026", "Fri Jul 10 2026", "July 10, 2026", "not-a-date"]) {
      const { compatible, reasons } = decisionFor(makeCandidate({ validFrom: legacy }));
      expect(compatible).toBe(false);
      expect(reasons).toContain("valid-from-invalid");
    }
    const legacyTarget: PhenomenonCandidate = { ...target, validFrom: "07/10/2026" };
    expect(decisionFor(makeCandidate(), legacyTarget).reasons).toContain("valid-from-invalid");
  });

  it("pins an offset-less validFrom to UTC regardless of host timezone", () => {
    const prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // Offset-less 12:04 vs explicit 12:00Z is 4 min under UTC pinning; a
      // local-time legacy parse would read it as 16:04Z and blow the 900 s cap.
      const offsetLess = makeCandidate({ validFrom: "2026-07-10T12:04:00" });
      const { compatible, reasons } = decisionFor(offsetLess);
      expect(compatible).toBe(true);
      expect(reasons).toEqual([]);
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it("names a direction mismatch when both carry attributes.direction", () => {
    const north: PhenomenonCandidate = { ...target, attributes: { direction: "north" } };
    const south = makeCandidate({ attributes: { direction: "south" } });
    const { compatible, reasons } = decisionFor(south, north);
    expect(compatible).toBe(false);
    expect(reasons).toContain("direction-mismatch");
  });

  it("is compatible when direction is absent on one side", () => {
    const north: PhenomenonCandidate = { ...target, attributes: { direction: "north" } };
    const noDir = makeCandidate({ attributes: {} });
    expect(decisionFor(noDir, north).compatible).toBe(true);
    expect(
      decisionFor(makeCandidate({ attributes: { direction: "north" } }), north).compatible
    ).toBe(true);
  });

  it("names the same reporter key (both crowd)", () => {
    const sameKey = makeCandidate({ actor: { keyId: "key-a", source: "crowd" } });
    const { compatible, reasons } = decisionFor(sameKey);
    expect(compatible).toBe(false);
    expect(reasons).toContain("same-reporter-key");
  });

  it("names the same source id (both feed)", () => {
    const feedTarget: PhenomenonCandidate = { ...target, actor: { source: "ndw" } };
    const sameFeed = makeCandidate({ actor: { source: "ndw" } });
    const { compatible, reasons } = decisionFor(sameFeed, feedTarget);
    expect(compatible).toBe(false);
    expect(reasons).toContain("same-source");
  });

  it("is compatible across a crowd/feed actor boundary even when sources coincide", () => {
    const feedTarget: PhenomenonCandidate = { ...target, actor: { source: "crowd" } };
    const crowd = makeCandidate({ actor: { keyId: "key-b", source: "crowd" } });
    expect(decisionFor(crowd, feedTarget).reasons).not.toContain("same-source");
  });

  it("names an inactive candidate", () => {
    const { compatible, reasons } = decisionFor(makeCandidate({ status: "inactive" }));
    expect(compatible).toBe(false);
    expect(reasons).toContain("candidate-inactive");
  });

  it("names a self match", () => {
    const { compatible, reasons } = decisionFor(makeCandidate({ id: target.id }));
    expect(compatible).toBe(false);
    expect(reasons).toContain("self-match");
  });

  it("reports every failed check at once (reasons are complete, not short-circuited)", () => {
    const broken = makeCandidate({
      id: target.id,
      domain: "transit",
      type: "roadwork",
      status: "inactive",
      geometry: { type: "Point", coordinates: pointNear(300, false) },
      validFrom: "2026-07-10T12:30:00Z",
      actor: { keyId: "key-a", source: "crowd" },
    });
    const { reasons } = decisionFor(broken);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "self-match",
        "domain-mismatch",
        "type-mismatch",
        "candidate-inactive",
        "centroid-distance-exceeds-max",
        "valid-from-delta-exceeds-max",
        "same-reporter-key",
      ])
    );
  });

  it("honours custom maxCentroidMeters and maxValidFromDeltaSec caps", () => {
    const cand = makeCandidate({
      geometry: { type: "Point", coordinates: pointNear(200, false) },
      validFrom: "2026-07-10T12:05:00Z",
    });
    const [strict] = matchPhenomenonCandidates(target, [cand], {
      maxCentroidMeters: 100,
      maxValidFromDeltaSec: 60,
    });
    expect(strict!.reasons).toContain("centroid-distance-exceeds-max");
    expect(strict!.reasons).toContain("valid-from-delta-exceeds-max");
  });
});
