import { describe, expect, it } from "vitest";
import { reportToObservation, type LandingContext } from "../report-to-observation.js";
import type { ReportClaim, SignedReport } from "../types.js";

const CTX: LandingContext = {
  instanceId: "maps.example.org",
  now: "2026-07-12T08:05:00.000Z",
  sourceUri: "https://maps.example.org/reports",
  sourceLicense: "ODbL-1.0",
};

function claim(overrides: Partial<ReportClaim> = {}): ReportClaim {
  return {
    domain: "roads",
    type: "congestion",
    geometry: { type: "Point", coordinates: [4.9, 52.37] },
    fuzziness: "low_res",
    reportedAt: "2026-07-12T08:00:00.000Z",
    nonce: "abcdefghijklmnop",
    ...overrides,
  };
}

function report(overrides: Partial<ReportClaim> = {}): SignedReport {
  return {
    alg: "ES256",
    keyId: "key-thumbprint-xyz",
    claim: claim(overrides),
    signature: "AAAA",
  };
}

describe("reportToObservation", () => {
  it("builds the id as crowd:<keyId>:<nonce>", () => {
    const obs = reportToObservation(report(), CTX);
    expect(obs.id).toBe("crowd:key-thumbprint-xyz:abcdefghijklmnop");
  });

  it("stamps source/sourceFormat/kind for a crowd event", () => {
    const obs = reportToObservation(report(), CTX);
    expect(obs.source).toBe("crowd");
    expect(obs.sourceFormat).toBe("crowd");
    expect(obs.kind).toBe("event");
  });

  it("maps domain/type/geometry/fuzziness/subject/severityLevel/attributes from the claim", () => {
    const obs = reportToObservation(
      report({
        domain: "transit",
        type: "hazard",
        subject: [{ type: "geo", id: "geo:52.37,4.9" }],
        severityLevel: 3,
        attributes: { note: "black ice" },
      }),
      CTX
    );
    expect(obs.domain).toBe("transit");
    expect(obs.type).toBe("hazard");
    expect(obs.geometry).toEqual({ type: "Point", coordinates: [4.9, 52.37] });
    expect(obs.fuzziness).toBe("low_res");
    expect(obs.subject).toEqual([{ type: "geo", id: "geo:52.37,4.9" }]);
    expect(obs.severityLevel).toBe(3);
    expect(obs.attributes).toEqual({ note: "black ice" });
  });

  it("builds a minimal crowd origin: attribution from ctx + reporter keyId, NO signature/reputation", () => {
    const obs = reportToObservation(report(), CTX);
    expect(obs.origin).toEqual({
      kind: "crowd",
      attribution: {
        provider: "maps.example.org",
        license: "ODbL-1.0",
        url: "https://maps.example.org/reports",
      },
      reporter: { keyId: "key-thumbprint-xyz" },
    });
    expect(obs.origin.kind).toBe("crowd");
    const reporter = (obs.origin as unknown as { reporter: Record<string, unknown> }).reporter;
    expect(reporter).not.toHaveProperty("signature");
    expect(reporter).not.toHaveProperty("reputation");
  });

  it("sets status active and validFrom = reportedAt (fingerprint + decay basis)", () => {
    const obs = reportToObservation(report(), CTX);
    expect(obs.status).toBe("active");
    expect(obs.validFrom).toBe("2026-07-12T08:00:00.000Z");
  });

  it("sets dataUpdatedAt = reportedAt and fetchedAt = ctx.now", () => {
    const obs = reportToObservation(report(), CTX);
    expect(obs.dataUpdatedAt).toBe("2026-07-12T08:00:00.000Z");
    expect(obs.fetchedAt).toBe("2026-07-12T08:05:00.000Z");
  });

  it("sets sourceUri/sourceLicense from the context", () => {
    const obs = reportToObservation(report(), CTX);
    expect(obs.sourceUri).toBe("https://maps.example.org/reports");
    expect(obs.sourceLicense).toBe("ODbL-1.0");
  });

  it("does NOT set any seam-owned provenance/evidence field (those are stamped centrally)", () => {
    const obs = reportToObservation(report({ severityLevel: 2 }), CTX) as unknown as Record<
      string,
      unknown
    >;
    expect(obs["privacyClass"]).toBeUndefined();
    expect(obs["canonicalId"]).toBeUndefined();
    expect(obs["phenomenonFingerprint"]).toBeUndefined();
    expect(obs["instanceId"]).toBeUndefined();
    expect(obs["evidenceState"]).toBeUndefined();
    expect(obs["routingEligible"]).toBeUndefined();
    expect(obs["confidenceScore"]).toBeUndefined();
    expect(obs["expiresAt"]).toBeUndefined();
  });

  it("marks the row not stale", () => {
    expect(reportToObservation(report(), CTX).isStale).toBe(false);
  });

  it("omits optional claim fields (subject/severityLevel/attributes) when absent", () => {
    const obs = reportToObservation(report(), CTX) as unknown as Record<string, unknown>;
    expect(obs["subject"]).toBeUndefined();
    expect(obs["severityLevel"]).toBeUndefined();
    expect(obs["attributes"]).toBeUndefined();
  });
});
