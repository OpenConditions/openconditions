import { canonicalId, type Observation } from "@openconditions/core";
import { describe, expect, it } from "vitest";
import { normalizeObservation, resolveInstanceId, type WriterContext } from "../index.js";

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
    geometry: { type: "Point", coordinates: [4, 52] },
    status: "active",
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

describe("normalizeObservation — stamping", () => {
  it("stamps instanceId, privacyClass and the derived canonicalId", () => {
    const out = normalizeObservation(feedReading(), CTX);
    expect(out.instanceId).toBe("inst-x");
    expect(out.privacyClass).toBe("authoritative");
    expect(out.canonicalId).toBe(canonicalId({ namespace: "src", recordId: "src:1" }));
  });

  it("overwrites an incoming (garbage) canonicalId with the derived value", () => {
    const out = normalizeObservation(feedReading({ canonicalId: "garbage" }), CTX);
    expect(out.canonicalId).toBe(canonicalId({ namespace: "src", recordId: "src:1" }));
    expect(out.canonicalId).not.toBe("garbage");
  });

  it("promotes attribution url/license into sourceUri/sourceLicense when absent", () => {
    const out = normalizeObservation(feedReading(), CTX);
    expect(out.sourceUri).toBe("https://ex.test/a");
    expect(out.sourceLicense).toBe("CC-BY-4.0");
  });

  it("passes through an explicit sourceUri/sourceLicense over the attribution", () => {
    const out = normalizeObservation(
      feedReading({ sourceUri: "https://own/x", sourceLicense: "ODbL-1.0" }),
      CTX,
    );
    expect(out.sourceUri).toBe("https://own/x");
    expect(out.sourceLicense).toBe("ODbL-1.0");
  });

  it("does NOT default fuzziness (left to the DB column default)", () => {
    const out = normalizeObservation(feedReading(), CTX);
    expect(out.fuzziness).toBeUndefined();
  });

  it("returns a new object without mutating the input", () => {
    const input = feedReading();
    const out = normalizeObservation(input, CTX);
    expect(out).not.toBe(input);
    expect(input.instanceId).toBeUndefined();
    expect(input.canonicalId).toBeUndefined();
    expect(input.privacyClass).toBeUndefined();
  });
});

describe("normalizeObservation — spoof rejection (trust boundary)", () => {
  it("throws when a parser sets a conflicting privacyClass", () => {
    expect(() => normalizeObservation(feedReading({ privacyClass: "dp_noised" }), CTX)).toThrow(
      /src:1/,
    );
  });

  it("throws when a parser sets a conflicting instanceId", () => {
    expect(() => normalizeObservation(feedReading({ instanceId: "evil" }), CTX)).toThrow(/src:1/);
  });

  it("does NOT throw when the incoming values equal the derived ones (idempotent)", () => {
    const stamped = feedReading({ privacyClass: "authoritative", instanceId: "inst-x" });
    expect(() => normalizeObservation(stamped, CTX)).not.toThrow();
  });

  it("throws when a feed-origin row carries kAnonymity", () => {
    expect(() => normalizeObservation(feedReading({ kAnonymity: 5 }), CTX)).toThrow(
      /src:1.*kAnonymity/,
    );
  });

  it("throws when a feed-origin row carries dpEpsilon", () => {
    expect(() => normalizeObservation(feedReading({ dpEpsilon: 0.1 }), CTX)).toThrow(
      /src:1.*dpEpsilon/,
    );
  });

  it("throws when a feed-origin row carries dpDelta", () => {
    expect(() => normalizeObservation(feedReading({ dpDelta: 0.001 }), CTX)).toThrow(
      /src:1.*dpDelta/,
    );
  });
});

describe("normalizeObservation — idempotence", () => {
  it("normalize(normalize(x)) deep-equals normalize(x)", () => {
    const once = normalizeObservation(feedReading(), CTX);
    const twice = normalizeObservation(once, CTX);
    expect(twice).toEqual(once);
  });
});

describe("resolveInstanceId", () => {
  it("returns the trimmed env value when set", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "  node-a  " })).toBe("node-a");
  });

  it("falls back to 'local' when unset", () => {
    expect(resolveInstanceId({})).toBe("local");
  });

  it("falls back to 'local' for a whitespace-only value", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "   " })).toBe("local");
  });

  it("falls back to 'local' for an empty value (Compose ${VAR:-} injection)", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "" })).toBe("local");
  });

  it("accepts a hostname and rejects ids that cannot be a record-id namespace", () => {
    expect(resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: "maps.example.org" })).toBe(
      "maps.example.org",
    );
    for (const bad of ["a:b", "Maps.example.org", "node_a", "-node", "node-"]) {
      expect(() => resolveInstanceId({ OPENCONDITIONS_INSTANCE_ID: bad })).toThrow(
        /not a valid instance id/,
      );
    }
  });
});
