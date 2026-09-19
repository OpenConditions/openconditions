import { describe, expect, it } from "vitest";
import { qualifierKey, subjectKey } from "../classes/observation.js";
import { jcs } from "../kernel/identity.js";

describe("observation storage keys", () => {
  const point = { type: "Point", coordinates: [8, 50] };

  it("keys features, segments, situations and locations", () => {
    const loc = { geometry: point };
    expect(subjectKey({ subject: { kind: "feature", featureId: "f" }, location: loc })).toBe(
      "feature:f",
    );
    expect(
      subjectKey({
        subject: { kind: "feature", featureId: "f", componentKey: "e5" },
        location: loc,
      }),
    ).toBe("feature:f#e5");
    expect(subjectKey({ subject: { kind: "situation", situationId: "s" }, location: loc })).toBe(
      "situation:s",
    );
    expect(subjectKey({ subject: { kind: "segments", spans: [{ a: 1 }] }, location: loc })).toMatch(
      /^segments:[0-9a-f]{64}$/,
    );
  });

  it("prefers the first admin geocode and ignores descriptive location fields", () => {
    const geocoded = { geometry: point, admin: { geocodes: [{ scheme: "padd", code: "1A" }] } };
    expect(subjectKey({ subject: { kind: "location" }, location: geocoded })).toBe(
      "location:padd:1A",
    );
    const a = subjectKey({ subject: { kind: "location" }, location: { geometry: point } });
    const b = subjectKey({
      subject: { kind: "location" },
      location: {
        geometry: point,
        fuzziness: "low_res",
        areaDescription: [{ lang: "en", text: "x" }],
      } as never,
    });
    expect(a).toBe(b);
  });

  it("uses JCS for qualifier keys so key order never matters", () => {
    expect(qualifierKey(undefined)).toBe("");
    expect(qualifierKey({ b: 1, a: "x" })).toBe(qualifierKey({ a: "x", b: 1 }));
    expect(qualifierKey({ a: "x", b: 1 })).toBe(jcs({ a: "x", b: 1 }));
  });
});
