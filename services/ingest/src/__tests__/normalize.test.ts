import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalId,
  phenomenonFingerprint,
  type ConditionEvent,
  type Observation,
} from "@openconditions/core";
import {
  normalizeObservation,
  resolveInstanceId,
  type WriterContext,
} from "../pipeline/normalize.js";
import { toRow } from "../pipeline/write-postgis.js";

const CTX: WriterContext = { kind: "feed", instanceId: "inst-x" };

function feedEvent(overrides: Record<string, unknown> = {}): Observation {
  return {
    id: "src:1",
    source: "src",
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

function feedMeasurement(overrides: Record<string, unknown> = {}): Observation {
  return {
    id: "src:m1",
    source: "src",
    sourceFormat: "native",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    geometry: { type: "Point", coordinates: [4, 52] },
    status: "active",
    origin: { kind: "feed", attribution: { provider: "P", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-06-24T10:00:00Z",
    fetchedAt: "2026-06-24T10:00:00Z",
    isStale: false,
    ...overrides,
  } as unknown as Observation;
}

describe("normalizeObservation — stamping", () => {
  it("stamps instanceId, privacyClass and the derived canonicalId", () => {
    const out = normalizeObservation(feedEvent(), CTX);
    expect(out.instanceId).toBe("inst-x");
    expect(out.privacyClass).toBe("authoritative");
    expect(out.canonicalId).toBe(canonicalId({ namespace: "src", recordId: "src:1" }));
  });

  it("stamps phenomenonFingerprint for an event", () => {
    const evt = feedEvent();
    const out = normalizeObservation(evt, CTX);
    expect(out.phenomenonFingerprint).toBe(phenomenonFingerprint(evt as ConditionEvent));
    expect(out.phenomenonFingerprint).toEqual(expect.any(String));
  });

  it("leaves phenomenonFingerprint unset for an event without validFrom (documents the fallback)", () => {
    const out = normalizeObservation(feedEvent({ validFrom: undefined }), CTX);
    expect(out.phenomenonFingerprint).toBeUndefined();
  });

  it("lands an event with a garbage validFrom string without a fingerprint (row survives)", () => {
    const out = normalizeObservation(feedEvent({ validFrom: "not-a-date" }), CTX);
    expect(out.phenomenonFingerprint).toBeUndefined();
    expect(out.instanceId).toBe("inst-x");
  });

  it("strips phenomenonFingerprint for a measurement (never phenomenon-collapsed)", () => {
    const out = normalizeObservation(
      feedMeasurement({ phenomenonFingerprint: "leaked" } as Record<string, unknown>),
      CTX
    );
    expect(out.phenomenonFingerprint).toBeUndefined();
  });

  it("overwrites an incoming (garbage) canonicalId with the derived value", () => {
    const out = normalizeObservation(feedEvent({ canonicalId: "garbage" }), CTX);
    expect(out.canonicalId).toBe(canonicalId({ namespace: "src", recordId: "src:1" }));
    expect(out.canonicalId).not.toBe("garbage");
  });

  it("promotes attribution url/license into sourceUri/sourceLicense when absent", () => {
    const out = normalizeObservation(feedEvent(), CTX);
    expect(out.sourceUri).toBe("https://ex.test/a");
    expect(out.sourceLicense).toBe("CC-BY-4.0");
  });

  it("passes through an explicit sourceUri/sourceLicense over the attribution", () => {
    const out = normalizeObservation(
      feedEvent({ sourceUri: "https://own/x", sourceLicense: "ODbL-1.0" }),
      CTX
    );
    expect(out.sourceUri).toBe("https://own/x");
    expect(out.sourceLicense).toBe("ODbL-1.0");
  });

  it("does NOT default fuzziness (left to the DB column default)", () => {
    const out = normalizeObservation(feedEvent(), CTX);
    expect(out.fuzziness).toBeUndefined();
  });

  it("returns a new object without mutating the input", () => {
    const input = feedEvent();
    const out = normalizeObservation(input, CTX);
    expect(out).not.toBe(input);
    expect(input.instanceId).toBeUndefined();
    expect(input.canonicalId).toBeUndefined();
    expect(input.privacyClass).toBeUndefined();
  });
});

describe("normalizeObservation — spoof rejection (trust boundary)", () => {
  it("throws when a parser sets a conflicting privacyClass", () => {
    expect(() => normalizeObservation(feedEvent({ privacyClass: "dp_noised" }), CTX)).toThrow(
      /src:1/
    );
  });

  it("throws when a parser sets a conflicting instanceId", () => {
    expect(() => normalizeObservation(feedEvent({ instanceId: "evil" }), CTX)).toThrow(/src:1/);
  });

  it("does NOT throw when the incoming values equal the derived ones (idempotent)", () => {
    const stamped = feedEvent({ privacyClass: "authoritative", instanceId: "inst-x" });
    expect(() => normalizeObservation(stamped, CTX)).not.toThrow();
  });

  it("throws when a feed-origin row carries kAnonymity", () => {
    expect(() => normalizeObservation(feedEvent({ kAnonymity: 5 }), CTX)).toThrow(
      /src:1.*kAnonymity/
    );
  });

  it("throws when a feed-origin row carries dpEpsilon", () => {
    expect(() => normalizeObservation(feedEvent({ dpEpsilon: 0.1 }), CTX)).toThrow(
      /src:1.*dpEpsilon/
    );
  });

  it("throws when a feed-origin row carries dpDelta", () => {
    expect(() => normalizeObservation(feedEvent({ dpDelta: 0.001 }), CTX)).toThrow(
      /src:1.*dpDelta/
    );
  });

  it("throws when a feed-origin row asserts evidenceState (derived, never parser-set)", () => {
    expect(() => normalizeObservation(feedEvent({ evidenceState: "corroborated" }), CTX)).toThrow(
      /src:1.*evidenceState/
    );
  });

  it("throws when a feed-origin row asserts routingEligible", () => {
    expect(() => normalizeObservation(feedEvent({ routingEligible: true }), CTX)).toThrow(
      /src:1.*routingEligible/
    );
  });
});

describe("normalizeObservation — confidenceScore strip", () => {
  it("silently strips a parser-set confidenceScore (derived presentation value)", () => {
    const out = normalizeObservation(feedEvent({ confidenceScore: 0.9 }), CTX);
    expect(out.confidenceScore).toBeUndefined();
    expect(toRow(out).confidence_score).toBeNull();
  });

  it("leaves the content_hash unaffected by a stripped confidenceScore", () => {
    const withScore = toRow(normalizeObservation(feedEvent({ confidenceScore: 0.9 }), CTX));
    const without = toRow(normalizeObservation(feedEvent(), CTX));
    expect(withScore.content_hash).toBe(without.content_hash);
  });

  it("stays idempotent through the strip", () => {
    const once = normalizeObservation(feedEvent({ confidenceScore: 0.9 }), CTX);
    const twice = normalizeObservation(once, CTX);
    expect(twice).toEqual(once);
  });
});

describe("normalizeObservation — non-TypeError from the fingerprint path propagates", () => {
  afterEach(() => {
    vi.doUnmock("@openconditions/core");
    vi.resetModules();
  });

  it("rethrows a non-TypeError instead of silently dropping the fingerprint", async () => {
    vi.resetModules();
    vi.doMock("@openconditions/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@openconditions/core")>();
      return {
        ...actual,
        phenomenonFingerprint: () => {
          throw new RangeError("simulated core regression");
        },
      };
    });
    const { normalizeObservation: normalize } = await import("../pipeline/normalize.js");
    expect(() => normalize(feedEvent(), CTX)).toThrow(RangeError);
  });
});

describe("normalizeObservation — soft-validation throw never aborts the swap", () => {
  afterEach(() => {
    vi.doUnmock("@openconditions/core");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns normally and logs once when validateObserved throws unexpectedly", async () => {
    vi.resetModules();
    vi.doMock("@openconditions/core", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@openconditions/core")>();
      return {
        ...actual,
        validateObserved: () => {
          throw new Error("simulated core regression");
        },
      };
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { normalizeObservation: normalize } = await import("../pipeline/normalize.js");

    const first = normalize(feedEvent(), CTX);
    expect(first.instanceId).toBe("inst-x");
    expect(first.canonicalId).toBe(canonicalId({ namespace: "src", recordId: "src:1" }));
    // Second row from the same source must not re-log the failure.
    expect(() => normalize(feedEvent({ id: "src:2" }), CTX)).not.toThrow();

    const failWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("validateObserved threw unexpectedly")
    );
    expect(failWarns).toHaveLength(1);
  });
});

describe("normalizeObservation — idempotence", () => {
  it("normalize(normalize(x)) deep-equals normalize(x)", () => {
    const once = normalizeObservation(feedEvent(), CTX);
    const twice = normalizeObservation(once, CTX);
    expect(twice).toEqual(once);
  });

  it("is content_hash-stable across re-normalization", () => {
    const once = normalizeObservation(feedEvent(), CTX);
    const twice = normalizeObservation(once, CTX);
    expect(toRow(twice).content_hash).toBe(toRow(once).content_hash);
  });
});

describe("normalizeObservation — content_hash impact", () => {
  it("stamping attribution url/license changes the hash vs the un-normalized row (one-time rewrite)", () => {
    const raw = feedEvent();
    const preSeam = toRow(raw).content_hash;
    const postSeam = toRow(normalizeObservation(raw, CTX)).content_hash;
    expect(postSeam).not.toBe(preSeam);
  });

  it("leaves the hash identical when the attribution carries no url/license", () => {
    const raw = feedEvent({
      origin: { kind: "feed", attribution: { provider: "P" } },
    });
    const preSeam = toRow(raw).content_hash;
    const postSeam = toRow(normalizeObservation(raw, CTX)).content_hash;
    expect(postSeam).toBe(preSeam);
  });
});

const CROWD_CTX: WriterContext = { kind: "crowd", instanceId: "maps.example.org" };

function crowdEvent(overrides: Record<string, unknown> = {}): Observation {
  return {
    id: "crowd:key-1:nonce-abcdefghij",
    source: "crowd",
    sourceFormat: "crowd",
    domain: "roads",
    kind: "event",
    type: "congestion",
    status: "active",
    validFrom: "2026-07-12T08:00:00Z",
    fuzziness: "low_res",
    geometry: { type: "Point", coordinates: [4.9, 52.37] },
    origin: {
      kind: "crowd",
      attribution: { provider: "maps.example.org", license: "ODbL-1.0" },
      reporter: { keyId: "key-1" },
    },
    dataUpdatedAt: "2026-07-12T08:00:00Z",
    fetchedAt: "2026-07-12T08:05:00Z",
    isStale: false,
    ...overrides,
  } as unknown as Observation;
}

describe("normalizeObservation — crowd writer context", () => {
  it("stamps privacyClass crowd_pseudonym and the instance id", () => {
    const out = normalizeObservation(crowdEvent(), CROWD_CTX);
    expect(out.privacyClass).toBe("crowd_pseudonym");
    expect(out.instanceId).toBe("maps.example.org");
  });

  it("namespaces canonicalId on the instance id for a crowd row (not the source)", () => {
    const out = normalizeObservation(crowdEvent(), CROWD_CTX);
    expect(out.canonicalId).toBe(
      canonicalId({ namespace: "maps.example.org", recordId: "crowd:key-1:nonce-abcdefghij" })
    );
    expect(out.canonicalId).not.toBe(
      canonicalId({ namespace: "crowd", recordId: "crowd:key-1:nonce-abcdefghij" })
    );
  });

  it("stamps the phenomenonFingerprint for a crowd event", () => {
    const evt = crowdEvent();
    const out = normalizeObservation(evt, CROWD_CTX);
    expect(out.phenomenonFingerprint).toBe(phenomenonFingerprint(evt as ConditionEvent));
  });

  it("rejects a crowd report that carries evidenceState", () => {
    expect(() =>
      normalizeObservation(crowdEvent({ evidenceState: "corroborated" }), CROWD_CTX)
    ).toThrow(/evidenceState/);
  });

  it("rejects a crowd report that carries routingEligible", () => {
    expect(() => normalizeObservation(crowdEvent({ routingEligible: true }), CROWD_CTX)).toThrow(
      /routingEligible/
    );
  });

  it("rejects a crowd report that carries confidenceScore", () => {
    expect(() => normalizeObservation(crowdEvent({ confidenceScore: 0.9 }), CROWD_CTX)).toThrow(
      /confidenceScore/
    );
  });

  it("rejects a crowd report that carries dpEpsilon", () => {
    expect(() => normalizeObservation(crowdEvent({ dpEpsilon: 0.1 }), CROWD_CTX)).toThrow(
      /dpEpsilon/
    );
  });

  it("rejects a crowd report that spoofs its own privacyClass", () => {
    expect(() =>
      normalizeObservation(crowdEvent({ privacyClass: "crowd_pseudonym" }), CROWD_CTX)
    ).toThrow(/privacyClass/);
  });

  it("rejects a crowd report that spoofs a conflicting instanceId", () => {
    expect(() => normalizeObservation(crowdEvent({ instanceId: "evil" }), CROWD_CTX)).toThrow(
      /instanceId|evil/
    );
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
});
