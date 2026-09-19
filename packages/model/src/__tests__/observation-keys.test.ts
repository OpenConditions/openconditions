import { describe, expect, it } from "vitest";
import {
  observationId,
  observationLocalId,
  qualifierKey,
  subjectKey,
} from "../classes/observation.js";
import { jcs } from "../kernel/identity.js";
import { draftBase, registry } from "./fixtures.js";

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

describe("observation ids", () => {
  const speed = {
    subject: { kind: "feature" as const, featureId: "oc:feature:de-ndw:SITE-1", componentKey: "1" },
    location: { geometry: { type: "Point", coordinates: [4.9, 52.37] } },
    property: "traffic.speed",
    phenomenonTime: { instant: "2026-09-18T09:59:00Z" },
  };

  it("names one point of one series", () => {
    const id = observationLocalId(speed);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(
      observationLocalId({ ...speed, phenomenonTime: { instant: "2026-09-18T11:59:00+02:00" } }),
    ).toBe(id);
    expect(
      observationLocalId({
        ...speed,
        phenomenonTime: { start: "2026-09-18T09:59:00Z", end: "2026-09-18T10:00:00Z" },
      }),
    ).toBe(id);
    expect(
      observationLocalId({ ...speed, phenomenonTime: { instant: "2026-09-18T10:00:00Z" } }),
    ).not.toBe(id);
    expect(
      observationLocalId({ ...speed, subject: { ...speed.subject, componentKey: "2" } }),
    ).not.toBe(id);
    expect(observationLocalId({ ...speed, qualifiers: { lane: 1 } })).not.toBe(id);
  });

  it("keeps forecasts for one target time apart by issue time", () => {
    const forecast = (issuedAt: string) => observationLocalId({ ...speed, forecast: { issuedAt } });
    expect(forecast("2026-09-18T06:00:00Z")).not.toBe(forecast("2026-09-18T07:00:00Z"));
    expect(forecast("2026-09-18T06:00:00Z")).not.toBe(observationLocalId(speed));
  });

  it("is enforced by validation", () => {
    const draft = {
      ...draftBase("observation", "x"),
      class: "observation",
      kind: "observation",
      property: "traffic.speed",
      subject: speed.subject,
      result: { type: "quantity", value: 87, unit: "km/h" },
      phenomenonTime: speed.phenomenonTime,
      aggregation: "mean",
    };
    expect(registry.validateDraft(draft)).toMatchObject({ ok: false });
    const named = { ...draft, id: observationId("de-ndw", draft) };
    expect(registry.validateDraft(named)).toMatchObject({ ok: true });
  });
});
