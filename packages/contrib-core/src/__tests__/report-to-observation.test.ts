import { describe, expect, it } from "vitest";
import {
  crowdObservationId,
  reportToObservation,
  type LandingContext,
} from "../report-to-observation.js";
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

describe("crowdObservationId", () => {
  it("is deterministic for the same key+nonce (idempotent replay)", async () => {
    const a = await crowdObservationId("key-thumbprint-xyz", "abcdefghijklmnop");
    const b = await crowdObservationId("key-thumbprint-xyz", "abcdefghijklmnop");
    expect(a).toBe(b);
  });

  it("differs for the same key with different nonces", async () => {
    const a = await crowdObservationId("key-thumbprint-xyz", "nonce-a");
    const b = await crowdObservationId("key-thumbprint-xyz", "nonce-b");
    expect(a).not.toBe(b);
  });

  it("de-identifies: the id never contains the raw keyId", async () => {
    const id = await crowdObservationId("SECRET-REPORTER-KEY-thumbprint", "some-nonce-0001");
    expect(id.startsWith("crowd:")).toBe(true);
    expect(id).not.toContain("SECRET-REPORTER-KEY-thumbprint");
  });
});

describe("reportToObservation", () => {
  it("builds a de-identified id: crowd:<sha256(keyId:nonce)>, not containing the keyId", async () => {
    const obs = await reportToObservation(report(), CTX);
    expect(obs.id).toBe(await crowdObservationId("key-thumbprint-xyz", "abcdefghijklmnop"));
    expect(obs.id).not.toContain("key-thumbprint-xyz");
  });

  it("stamps source/sourceFormat/kind for a crowd event", async () => {
    const obs = await reportToObservation(report(), CTX);
    expect(obs.source).toBe("crowd");
    expect(obs.sourceFormat).toBe("crowd");
    expect(obs.kind).toBe("event");
  });

  it("maps domain/type/geometry/fuzziness/subject/severityLevel/attributes from the claim", async () => {
    const obs = await reportToObservation(
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

  it("strips model-owned keys from the untrusted attributes bag (anti-forgery)", async () => {
    const obs = await reportToObservation(
      report({
        attributes: {
          note: "genuine extra",
          origin: { kind: "feed", attribution: { provider: "spoof", license: "CC0-1.0" } },
          privacyClass: "authoritative",
          sourceLicense: "MIT",
          id: "forged-id",
          confidenceScore: 1,
          severityLevel: 5,
        },
      }),
      CTX
    );
    // Only the genuine extra survives; every model-owned key is dropped.
    expect(obs.attributes).toEqual({ note: "genuine extra" });
  });

  it("builds a minimal crowd origin: attribution from ctx + reporter keyId, NO signature/reputation", async () => {
    const obs = await reportToObservation(report(), CTX);
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

  it("sets status active and validFrom = reportedAt (fingerprint + decay basis)", async () => {
    const obs = await reportToObservation(report(), CTX);
    expect(obs.status).toBe("active");
    expect(obs.validFrom).toBe("2026-07-12T08:00:00.000Z");
  });

  it("sets dataUpdatedAt = reportedAt and fetchedAt = ctx.now", async () => {
    const obs = await reportToObservation(report(), CTX);
    expect(obs.dataUpdatedAt).toBe("2026-07-12T08:00:00.000Z");
    expect(obs.fetchedAt).toBe("2026-07-12T08:05:00.000Z");
  });

  it("sets sourceUri/sourceLicense from the context", async () => {
    const obs = await reportToObservation(report(), CTX);
    expect(obs.sourceUri).toBe("https://maps.example.org/reports");
    expect(obs.sourceLicense).toBe("ODbL-1.0");
  });

  it("does NOT set any seam-owned provenance/evidence field (those are stamped centrally)", async () => {
    const obs = (await reportToObservation(report({ severityLevel: 2 }), CTX)) as unknown as Record<
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

  it("marks the row not stale", async () => {
    expect((await reportToObservation(report(), CTX)).isStale).toBe(false);
  });

  it("omits optional claim fields (subject/severityLevel/attributes) when absent", async () => {
    const obs = (await reportToObservation(report(), CTX)) as unknown as Record<string, unknown>;
    expect(obs["subject"]).toBeUndefined();
    expect(obs["severityLevel"]).toBeUndefined();
    expect(obs["attributes"]).toBeUndefined();
  });
});
