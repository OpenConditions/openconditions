import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Observation } from "@openconditions/core";
import { normalizeObservation, type WriterContext } from "../pipeline/normalize.js";

const CTX: WriterContext = { kind: "feed", instanceId: "inst-x" };

function event(source: string, overrides: Record<string, unknown> = {}): Observation {
  return {
    id: `${source}:1`,
    source,
    sourceFormat: "geojson",
    domain: "roads",
    kind: "event",
    type: "roadworks",
    category: "planned",
    severity: "low",
    severitySource: "declared",
    headline: "H",
    status: "active",
    validFrom: "2026-06-24T10:00:00Z",
    geometry: { type: "Point", coordinates: [4, 52] },
    origin: { kind: "feed", attribution: { provider: "P", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-06-24T10:00:00Z",
    fetchedAt: "2026-06-24T10:00:00Z",
    isStale: false,
    ...overrides,
  } as unknown as Observation;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe("normalizeObservation — soft observed-property validation", () => {
  it("logs no warning for a known (domain, type)", () => {
    normalizeObservation(event("known-src", { type: "accident" }), CTX);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs one warning for an unknown type and still returns a normalized row", () => {
    const out = normalizeObservation(event("unknown-src", { type: "meteor_strike" }), CTX);
    expect(out.instanceId).toBe("inst-x");
    expect(out.canonicalId).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("roads/meteor_strike");
  });

  it("rate-limits to once per (source, key) across many rows", () => {
    for (let i = 0; i < 5; i++) {
      normalizeObservation(event("rl-src", { id: `rl-src:${i}`, type: "unregistered_kind" }), CTX);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns separately for a different source carrying the same unknown key", () => {
    normalizeObservation(event("src-a", { id: "src-a:1", type: "unheard_of" }), CTX);
    normalizeObservation(event("src-b", { id: "src-b:1", type: "unheard_of" }), CTX);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not warn for the currently-ingested roads flow measurement", () => {
    normalizeObservation(
      {
        id: "flow-src:1",
        source: "flow-src",
        sourceFormat: "native",
        domain: "roads",
        kind: "measurement",
        metric: "flow",
        aggregation: "live",
        unit: "km/h",
        geometry: { type: "Point", coordinates: [4, 52] },
        status: "active",
        origin: { kind: "feed", attribution: { provider: "P", license: "CC0-1.0" } },
        dataUpdatedAt: "2026-06-24T10:00:00Z",
        fetchedAt: "2026-06-24T10:00:00Z",
        isStale: false,
      } as unknown as Observation,
      CTX
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
