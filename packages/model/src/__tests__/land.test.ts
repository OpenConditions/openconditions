import { describe, expect, it } from "vitest";
import { crowdLocalId, type LandingContext, landClaim } from "../crowd/land.js";
import type { LocationRef } from "../kernel/types.js";
import { sealRecord } from "../registry/seal.js";
import { accidentClaim, crowdAttribution, crowdRegistry, KEY, NOW } from "./crowd-fixtures.js";

const station: LocationRef = {
  geometry: { type: "Point", coordinates: [-3.7038, 40.4168] },
  extent: "point",
  geometryOrigin: "source",
  fuzziness: "exact",
};

const ctx: LandingContext = {
  instanceId: "oc.example.org",
  now: NOW,
  attribution: crowdAttribution,
  resolveFeature: (featureId, componentKey) =>
    featureId === "oc:feature:es-minetur:4375" && componentKey === "e5"
      ? { featureId: "oc:feature:oc.example.org:c1", componentKey: "e5", location: station }
      : undefined,
};

const priceClaim = (overrides: Record<string, unknown> = {}) => ({
  claimClass: "observation",
  subject: { featureId: "oc:feature:es-minetur:4375", componentKey: "e5" },
  property: "fuel.price",
  result: { type: "money", amount: "1.479", currency: "EUR", per: "L" },
  // About 15 m from the station, at the pole.
  geometry: { type: "Point", coordinates: [-3.7037, 40.4169] },
  reportedAt: "2026-10-01T11:58:00Z",
  nonce: "nonce-0000000000000002",
  ...overrides,
});

describe("landing a claim", () => {
  it("lands a situation claim as a crowd situation that expires after its kind's lifetime", () => {
    const landed = landClaim(
      crowdRegistry,
      {
        claim: accidentClaim({ severityLevel: 4, text: [{ lang: "de", text: "Auffahrunfall" }] }),
        keyId: KEY,
      },
      ctx,
    );
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    const localId = crowdLocalId(KEY, "nonce-0000000000000001");
    expect(landed.expiresAt).toBe("2026-10-01T12:28:00.000Z");
    expect(landed.draft).toMatchObject({
      id: `oc:situation:oc.example.org:${localId}`,
      kind: "incident",
      type: "accident",
      temporality: "live",
      location: { extent: "point", geometryOrigin: "crowd_device", fuzziness: "exact" },
      provenance: {
        origin: "crowd",
        sourceId: "crowd",
        sourceFormat: "crowd",
        recordId: localId,
        reporter: { keyId: KEY },
        privacy: { class: "crowd_pseudonym" },
      },
      freshness: { fetchedAt: NOW, expiresAt: "2026-10-01T12:28:00.000Z" },
      planned: false,
      certainty: "observed",
      severity: { label: "major", level: 4, source: "declared" },
      description: [{ lang: "de", text: "Auffahrunfall" }],
      validity: { status: "active", start: "2026-10-01T11:58:00Z" },
      effects: [],
      details: { kind: "incident", v: 1 },
    });
    expect(localId).not.toContain(KEY);
  });

  it("maps DATEX's five severity steps onto the kernel's labels, and leaves none unknown", () => {
    const label = (severityLevel?: number) => {
      const landed = landClaim(
        crowdRegistry,
        { claim: accidentClaim(severityLevel === undefined ? {} : { severityLevel }), keyId: KEY },
        ctx,
      );
      return landed.ok ? (landed.draft["severity"] as { label: string }).label : "refused";
    };
    expect([1, 2, 3, 4, 5].map(label)).toEqual(["minor", "minor", "moderate", "major", "critical"]);
    expect(label()).toBe("unknown");
  });

  it("uses a type's own lifetime", () => {
    const landed = landClaim(
      crowdRegistry,
      { claim: accidentClaim({ type: "obstruction", subtype: "animal" }), keyId: KEY },
      ctx,
    );
    expect(landed.ok && landed.expiresAt).toBe("2026-10-01T12:13:00.000Z");
  });

  it("lands an observation claim on the canonical feature and component", () => {
    const landed = landClaim(crowdRegistry, { claim: priceClaim(), keyId: KEY }, ctx);
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    expect(landed.draft).toMatchObject({
      class: "observation",
      property: "fuel.price",
      subject: { kind: "feature", featureId: "oc:feature:oc.example.org:c1", componentKey: "e5" },
      phenomenonTime: { instant: "2026-10-01T11:58:00Z" },
      aggregation: "instantaneous",
      location: station,
      provenance: { origin: "crowd", reporter: { keyId: KEY } },
    });
    expect(landed.draft["validUntil"]).toBeUndefined();
    expect(landed.draft["id"]).toMatch(/^oc:observation:oc\.example\.org:[0-9a-f]{64}$/);
  });

  it("refuses a feature or component the instance does not know", () => {
    const landed = landClaim(
      crowdRegistry,
      {
        claim: priceClaim({
          subject: { featureId: "oc:feature:es-minetur:4375", componentKey: "diesel" },
        }),
        keyId: KEY,
      },
      ctx,
    );
    expect(landed).toEqual({
      ok: false,
      issues: [
        {
          path: ["subject"],
          code: "unknown_subject",
          message: "no feature oc:feature:es-minetur:4375 with component diesel",
        },
      ],
    });
  });

  it("refuses a report from the future or one that died on the way", () => {
    const code = (reportedAt: string) => {
      const landed = landClaim(
        crowdRegistry,
        { claim: accidentClaim({ reportedAt }), keyId: KEY },
        ctx,
      );
      return landed.ok ? "landed" : landed.issues[0]!.code;
    };
    expect(code("2026-10-01T12:04:59Z")).toBe("landed");
    expect(code("2026-10-01T12:05:01Z")).toBe("reported_in_future");
    expect(code("2026-10-01T11:30:01Z")).toBe("landed");
    expect(code("2026-10-01T11:30:00Z")).toBe("expired_on_arrival");
  });

  it("refuses a report uploaded more than a day late, however long its kind lives", () => {
    const works = (reportedAt: string) => {
      const landed = landClaim(
        crowdRegistry,
        { claim: accidentClaim({ kind: "roadworks", type: "works", reportedAt }), keyId: KEY },
        ctx,
      );
      return landed.ok ? "landed" : landed.issues[0]!.code;
    };
    expect(works("2026-09-30T12:00:00Z")).toBe("landed");
    expect(works("2026-09-30T11:59:59Z")).toBe("reported_too_long_ago");
  });

  it("refuses a reading from a reporter who stood too far from its subject", () => {
    const from = (lon: number, lat: number) => {
      const landed = landClaim(
        crowdRegistry,
        { claim: priceClaim({ geometry: { type: "Point", coordinates: [lon, lat] } }), keyId: KEY },
        ctx,
      );
      return landed.ok ? "landed" : landed.issues[0]!.message;
    };
    expect(from(-3.7038, 40.4194)).toBe("landed");
    expect(from(-3.7038, 40.4198)).toBe("reported 334 m from the subject, further than 300 m");
    expect(from(2.17, 41.38)).toMatch(/^reported 50\d{4} m from the subject/);
  });

  it("refuses a reading of a feature that has no position to observe it at", () => {
    const landed = landClaim(
      crowdRegistry,
      { claim: priceClaim(), keyId: KEY },
      {
        ...ctx,
        resolveFeature: (featureId, componentKey) => ({
          featureId,
          ...(componentKey === undefined ? {} : { componentKey }),
          location: { geometry: null, extent: "none", geometryOrigin: "none", fuzziness: "exact" },
        }),
      },
    );
    expect(landed).toMatchObject({ ok: false, issues: [{ code: "out_of_reach" }] });
  });

  it("lands a replayed claim under the same id, and a draft the write seam seals", () => {
    const a = landClaim(crowdRegistry, { claim: accidentClaim(), keyId: KEY }, ctx);
    const b = landClaim(crowdRegistry, { claim: accidentClaim(), keyId: KEY }, ctx);
    expect(a.ok && b.ok && a.draft["id"] === b.draft["id"]).toBe(true);
    if (!a.ok) return;
    const sealed = sealRecord(crowdRegistry, a.draft, {
      instanceId: "oc.example.org",
      revision: 1,
      recordedAt: NOW,
    });
    expect(sealed.ok).toBe(true);
  });
});
