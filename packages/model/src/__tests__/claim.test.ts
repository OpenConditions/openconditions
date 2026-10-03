import { describe, expect, it } from "vitest";
import { validateClaim, validateSubClaim } from "../crowd/claim.js";
import { accidentClaim, crowdRegistry } from "./crowd-fixtures.js";

const messages = (r: ReturnType<typeof validateClaim>) =>
  r.ok ? [] : r.issues.map((i) => `${i.path.join(".")}: ${i.message}`);

const priceClaim = (overrides: Record<string, unknown> = {}) => ({
  claimClass: "observation",
  subject: { featureId: "oc:feature:es-minetur:4375", componentKey: "e5" },
  property: "fuel.price",
  result: { type: "money", amount: "1.479", currency: "EUR", per: "L" },
  geometry: { type: "Point", coordinates: [-3.7037, 40.4169] },
  reportedAt: "2026-10-01T11:58:00Z",
  nonce: "nonce-0000000000000002",
  ...overrides,
});

describe("report claims", () => {
  it("accepts a situation claim of a kind the crowd reports", () => {
    expect(messages(validateClaim(crowdRegistry, accidentClaim()))).toEqual([]);
    expect(
      messages(
        validateClaim(crowdRegistry, accidentClaim({ subtype: "overturned", severityLevel: 4 })),
      ),
    ).toEqual([]);
  });

  it("refuses kinds the crowd cannot report, and unregistered types and subtypes", () => {
    expect(messages(validateClaim(crowdRegistry, accidentClaim({ kind: "restriction" })))).toEqual([
      expect.stringMatching(/^kind: /),
    ]);
    expect(messages(validateClaim(crowdRegistry, accidentClaim({ type: "breakdown" })))).toEqual([
      'type: "breakdown" is not a type of incident',
    ]);
    expect(messages(validateClaim(crowdRegistry, accidentClaim({ subtype: "animal" })))).toEqual([
      'subtype: "animal" is not a subtype of incident.accident',
    ]);
  });

  it("takes the details a kind requires from the claim", () => {
    const jam = accidentClaim({ kind: "congestion", type: "congestion" });
    expect(messages(validateClaim(crowdRegistry, jam))).toEqual([
      expect.stringMatching(/^details\.los: /),
    ]);
    expect(
      messages(
        validateClaim(crowdRegistry, {
          ...jam,
          details: { kind: "congestion", v: 1, los: "queuing" },
        }),
      ),
    ).toEqual([]);
  });

  it("validates effects with the kernel and refuses repeated effect ids", () => {
    const closure = {
      id: "closure:1",
      kind: "closure",
      v: 1,
      scope: "road",
      applicability: { kind: "all" },
      compliance: "mandatory",
      normalization: "complete",
    };
    expect(messages(validateClaim(crowdRegistry, accidentClaim({ effects: [closure] })))).toEqual(
      [],
    );
    expect(
      messages(validateClaim(crowdRegistry, accidentClaim({ effects: [closure, closure] }))),
    ).toEqual(["effects: effect ids repeat"]);
  });

  it("refuses a geometry off the globe, a zone-less time and a short nonce", () => {
    expect(
      validateClaim(
        crowdRegistry,
        accidentClaim({ geometry: { type: "Point", coordinates: [8.4, 91] } }),
      ).ok,
    ).toBe(false);
    expect(
      validateClaim(crowdRegistry, accidentClaim({ reportedAt: "2026-10-01T11:58:00" })).ok,
    ).toBe(false);
    expect(validateClaim(crowdRegistry, accidentClaim({ nonce: "short" })).ok).toBe(false);
  });

  it("validates an observation claim's result and qualifiers as its property's observations", () => {
    expect(messages(validateClaim(crowdRegistry, priceClaim()))).toEqual([]);
    expect(
      messages(
        validateClaim(
          crowdRegistry,
          priceClaim({ result: { type: "money", amount: "1.479", currency: "EUR", per: "kg" } }),
        ),
      ),
    ).toEqual([expect.stringMatching(/^result/)]);
    expect(
      messages(validateClaim(crowdRegistry, priceClaim({ qualifiers: { product: "e5" } }))),
    ).toEqual([expect.stringMatching(/^qualifiers/)]);
    expect(
      messages(validateClaim(crowdRegistry, priceClaim({ result: { type: "unknown" } }))),
    ).toEqual([]);
  });

  it("only takes subjects the property is observed about", () => {
    expect(
      messages(
        validateClaim(crowdRegistry, {
          ...priceClaim(),
          property: "charging.evse_status",
          subject: {
            location: {
              geometry: { type: "Point", coordinates: [8.4, 49] },
              extent: "point",
              geometryOrigin: "crowd_device",
              fuzziness: "exact",
            },
          },
          result: { type: "category", value: "blocked", vocabulary: "los" },
        }),
      ),
    ).toEqual(["subject: charging.evse_status is not observed about a location"]);
    expect(
      messages(validateClaim(crowdRegistry, priceClaim({ property: "traffic.speed" }))),
    ).toEqual([expect.stringMatching(/^property: /)]);
  });

  it("needs where the reporter stood, as a point", () => {
    const { geometry: _, ...withoutPosition } = priceClaim();
    expect(messages(validateClaim(crowdRegistry, withoutPosition))).toEqual([
      expect.stringMatching(/^geometry: /),
    ]);
    expect(
      validateClaim(
        crowdRegistry,
        priceClaim({ geometry: { type: "MultiPoint", coordinates: [[-3.7, 40.4]] } }),
      ).ok,
    ).toBe(false);
  });
});

describe("sub-claims", () => {
  const body = {
    subject: { class: "observation", id: "oc:observation:oc.example.org:abc" },
    claimType: "negate",
    reportedAt: "2026-10-01T11:58:00Z",
    nonce: "nonce-0000000000000003",
  };

  it("names any record, a component included", () => {
    expect(validateSubClaim(body).ok).toBe(true);
    expect(
      validateSubClaim({
        ...body,
        subject: { class: "feature", id: "oc:feature:de-bw-ocpdb:1", componentKey: "DE*ABC*E1" },
        claimType: "flag",
        reason: "this charger was removed",
      }).ok,
    ).toBe(true);
  });

  it("refuses a bare id, an unknown reaction and a geometry that is not where the reporter stood", () => {
    expect(validateSubClaim({ ...body, subject: "oc:observation:oc.example.org:abc" }).ok).toBe(
      false,
    );
    expect(validateSubClaim({ ...body, claimType: "like" }).ok).toBe(false);
    expect(
      validateSubClaim({
        ...body,
        geometry: {
          type: "LineString",
          coordinates: [
            [8.4, 49],
            [8.5, 49],
          ],
        },
      }).ok,
    ).toBe(false);
  });

  it("names a component only of a feature", () => {
    const situationPart = validateSubClaim({
      ...body,
      subject: { class: "situation", id: "oc:situation:nl-ndw-events:SIT-1", componentKey: "1" },
    });
    expect(situationPart.ok).toBe(false);
    expect(!situationPart.ok && situationPart.issues[0]!.message).toBe(
      "only a feature has components",
    );
  });
});
