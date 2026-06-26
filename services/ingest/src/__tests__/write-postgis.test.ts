import { describe, expect, it } from "vitest";
import type { Observation } from "@openconditions/core";
import { toRow } from "../pipeline/write-postgis.js";

/** A minimal valid roads event; overrides exercise the timestamp coercion. */
function baseObs(overrides: Record<string, unknown> = {}): Observation {
  return {
    id: "on-511:1",
    source: "on-511",
    sourceFormat: "ibi511-json",
    domain: "roads",
    kind: "event",
    type: "roadworks",
    category: "planned",
    isPlanned: true,
    severity: "low",
    severitySource: "declared",
    status: "active",
    geometry: { type: "Point", coordinates: [-79.38, 43.65] },
    roads: [],
    headline: "Test",
    origin: { kind: "feed", attribution: {} },
    dataUpdatedAt: "2026-06-25T10:00:00.000Z",
    fetchedAt: "2026-06-25T10:00:00.000Z",
    isStale: false,
    ...overrides,
  } as unknown as Observation;
}

describe("toRow timestamp coercion (defense-in-depth)", () => {
  it("coerces epoch-seconds valid_from/valid_to to ISO", () => {
    const r = toRow(baseObs({ validFrom: 1757502000, validTo: "1757502000" }));
    expect(r.valid_from).toBe("2025-09-10T11:00:00.000Z");
    expect(r.valid_to).toBe("2025-09-10T11:00:00.000Z");
  });

  it("nulls an unparseable valid_from/valid_to rather than letting it abort the batch", () => {
    const r = toRow(baseObs({ validFrom: "garbage", validTo: "" }));
    expect(r.valid_from).toBeNull();
    expect(r.valid_to).toBeNull();
  });

  it("keeps the NOT NULL data_updated_at/fetched_at valid even when the source value is malformed", () => {
    const r = toRow(baseObs({ dataUpdatedAt: "garbage", fetchedAt: "garbage" }));
    expect(r.data_updated_at).not.toBeNull();
    expect(r.fetched_at).not.toBeNull();
    expect(Number.isNaN(Date.parse(r.data_updated_at))).toBe(false);
    expect(Number.isNaN(Date.parse(r.fetched_at))).toBe(false);
  });
});
