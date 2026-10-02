import type { Observation } from "@openconditions/core";
import { normalizeObservation, type WriterContext } from "@openconditions/normalize";
import { describe, expect, it } from "vitest";
import { toRow } from "../pipeline/write-postgis.js";

// The write-normalization seam lives in @openconditions/normalize, but its
// content_hash impact is only observable through this service's toRow (the ONE
// content-hash implementation, now in AGPL @openconditions/storage). These
// tests pin that the normalize → toRow coupling stays byte-stable: the golden
// hash behavior must not drift when the seam moves packages.

const CTX: WriterContext = { kind: "feed", instanceId: "inst-x" };

function feedReading(overrides: Record<string, unknown> = {}): Observation {
  return {
    id: "src:1",
    source: "src",
    sourceFormat: "native",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    value: 40,
    unit: "km/h",
    aggregation: "live",
    status: "active",
    geometry: { type: "Point", coordinates: [4, 52] },
    origin: {
      kind: "feed",
      attribution: { provider: "P", license: "CC-BY-4.0", url: "https://ex.test/a" },
    },
    dataUpdatedAt: "2026-06-24T10:00:00Z",
    fetchedAt: "2026-06-24T10:00:00Z",
    isStale: false,
    ...overrides,
  } as unknown as Observation;
}

describe("normalizeObservation → toRow — idempotence", () => {
  it("is content_hash-stable across re-normalization", () => {
    const once = normalizeObservation(feedReading(), CTX);
    const twice = normalizeObservation(once, CTX);
    expect(toRow(twice).content_hash).toBe(toRow(once).content_hash);
  });
});

describe("normalizeObservation → toRow — content_hash impact", () => {
  it("stamping attribution url/license changes the hash vs the un-normalized row (one-time rewrite)", () => {
    const raw = feedReading();
    const preSeam = toRow(raw).content_hash;
    const postSeam = toRow(normalizeObservation(raw, CTX)).content_hash;
    expect(postSeam).not.toBe(preSeam);
  });

  it("leaves the hash identical when the attribution carries no url/license", () => {
    const raw = feedReading({
      origin: { kind: "feed", attribution: { provider: "P" } },
    });
    const preSeam = toRow(raw).content_hash;
    const postSeam = toRow(normalizeObservation(raw, CTX)).content_hash;
    expect(postSeam).toBe(preSeam);
  });
});
