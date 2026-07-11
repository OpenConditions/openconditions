import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECAY_TTLS,
  FALLBACK_DECAY,
  decayMaxLifetimeSec,
  decayTtlSec,
  expiresAtFor,
  type DecayEntry,
} from "../decay.js";

const EXPECTED: Record<string, DecayEntry> = {
  congestion: { crowdTtlSec: 300, feedTtlSec: 600, maxLifetimeSec: 3600 },
  hazard: { crowdTtlSec: 900, feedTtlSec: 1800, maxLifetimeSec: 7200 },
  accident: { crowdTtlSec: 1800, feedTtlSec: 3600, maxLifetimeSec: 14400 },
  road_closure: { crowdTtlSec: 14400, feedTtlSec: 28800, maxLifetimeSec: 86400 },
  lane_closure: { crowdTtlSec: 14400, feedTtlSec: 28800, maxLifetimeSec: 86400 },
  roadworks: { crowdTtlSec: 604800, feedTtlSec: 1209600, maxLifetimeSec: 2592000 },
  transit_disruption: { crowdTtlSec: 1800, feedTtlSec: 3600, maxLifetimeSec: 14400 },
  accessibility: { crowdTtlSec: 7200, feedTtlSec: 14400, maxLifetimeSec: 43200 },
};

describe("DEFAULT_DECAY_TTLS table", () => {
  it("matches the binding policy values exactly", () => {
    expect(DEFAULT_DECAY_TTLS).toStrictEqual(EXPECTED);
  });

  it("keeps crowd < feed for every entry (crowd data is trusted less)", () => {
    for (const [type, entry] of Object.entries(DEFAULT_DECAY_TTLS)) {
      expect(entry.crowdTtlSec, `${type} crowd < feed`).toBeLessThan(entry.feedTtlSec);
    }
    expect(FALLBACK_DECAY.crowdTtlSec).toBeLessThan(FALLBACK_DECAY.feedTtlSec);
  });

  it("keeps maxLifetime >= feed >= crowd for every entry", () => {
    for (const [type, entry] of Object.entries(DEFAULT_DECAY_TTLS)) {
      expect(entry.feedTtlSec, `${type} feed <= max`).toBeLessThanOrEqual(entry.maxLifetimeSec);
      expect(entry.crowdTtlSec, `${type} crowd <= feed`).toBeLessThanOrEqual(entry.feedTtlSec);
    }
    expect(FALLBACK_DECAY.feedTtlSec).toBeLessThanOrEqual(FALLBACK_DECAY.maxLifetimeSec);
    expect(FALLBACK_DECAY.crowdTtlSec).toBeLessThanOrEqual(FALLBACK_DECAY.feedTtlSec);
  });

  it("carries only finite non-negative values", () => {
    for (const entry of [...Object.values(DEFAULT_DECAY_TTLS), FALLBACK_DECAY]) {
      for (const v of Object.values(entry)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("decayTtlSec", () => {
  it("returns the exact crowd and feed TTL for every table row", () => {
    for (const [type, entry] of Object.entries(EXPECTED)) {
      expect(decayTtlSec(type, "crowd")).toBe(entry.crowdTtlSec);
      expect(decayTtlSec(type, "feed")).toBe(entry.feedTtlSec);
    }
  });

  it("falls back to FALLBACK_DECAY for an unknown type", () => {
    expect(decayTtlSec("no_such_type", "crowd")).toBe(FALLBACK_DECAY.crowdTtlSec);
    expect(decayTtlSec("no_such_type", "feed")).toBe(FALLBACK_DECAY.feedTtlSec);
  });

  it("throws TypeError on an unknown origin", () => {
    // @ts-expect-error exercising the runtime guard with an invalid origin
    expect(() => decayTtlSec("congestion", "official")).toThrow(TypeError);
    // @ts-expect-error exercising the runtime guard with a missing origin
    expect(() => decayTtlSec("congestion", undefined)).toThrow(TypeError);
  });

  it("merges a partial override, keeping the other fields at their defaults", () => {
    const overrides = { congestion: { crowdTtlSec: 120 } };
    expect(decayTtlSec("congestion", "crowd", overrides)).toBe(120);
    expect(decayTtlSec("congestion", "feed", overrides)).toBe(EXPECTED.congestion.feedTtlSec);
  });

  it("applies an override to an otherwise-unknown type over the fallback", () => {
    const overrides = { brand_new_type: { feedTtlSec: 42 } };
    expect(decayTtlSec("brand_new_type", "feed", overrides)).toBe(42);
    expect(decayTtlSec("brand_new_type", "crowd", overrides)).toBe(FALLBACK_DECAY.crowdTtlSec);
  });

  it("throws TypeError on a non-finite or negative override value", () => {
    expect(() => decayTtlSec("congestion", "crowd", { congestion: { crowdTtlSec: -1 } })).toThrow(
      TypeError
    );
    expect(() =>
      decayTtlSec("congestion", "crowd", { congestion: { crowdTtlSec: Number.NaN } })
    ).toThrow(TypeError);
    expect(() =>
      decayTtlSec("congestion", "crowd", { congestion: { crowdTtlSec: Number.POSITIVE_INFINITY } })
    ).toThrow(TypeError);
  });
});

describe("decayMaxLifetimeSec", () => {
  it("returns the exact maxLifetime for every table row", () => {
    for (const [type, entry] of Object.entries(EXPECTED)) {
      expect(decayMaxLifetimeSec(type)).toBe(entry.maxLifetimeSec);
    }
  });

  it("falls back for an unknown type and honours an override", () => {
    expect(decayMaxLifetimeSec("no_such_type")).toBe(FALLBACK_DECAY.maxLifetimeSec);
    expect(decayMaxLifetimeSec("congestion", { congestion: { maxLifetimeSec: 99 } })).toBe(99);
  });

  it("throws TypeError on a bad override value", () => {
    expect(() => decayMaxLifetimeSec("congestion", { congestion: { maxLifetimeSec: -5 } })).toThrow(
      TypeError
    );
  });
});

describe("expiresAtFor", () => {
  it("adds the origin TTL to a zoned instant (exact ISO in/out)", () => {
    // congestion crowd TTL = 300 s
    expect(expiresAtFor("2026-07-11T12:00:00.000Z", "congestion", "crowd")).toBe(
      "2026-07-11T12:05:00.000Z"
    );
    // congestion feed TTL = 600 s
    expect(expiresAtFor("2026-07-11T12:00:00.000Z", "congestion", "feed")).toBe(
      "2026-07-11T12:10:00.000Z"
    );
  });

  it("pins an offset-less datetime to UTC before adding the TTL", () => {
    expect(expiresAtFor("2026-07-11T12:00:00", "congestion", "crowd")).toBe(
      "2026-07-11T12:05:00.000Z"
    );
  });

  it("respects a per-type override", () => {
    expect(
      expiresAtFor("2026-07-11T12:00:00.000Z", "congestion", "crowd", {
        congestion: { crowdTtlSec: 60 },
      })
    ).toBe("2026-07-11T12:01:00.000Z");
  });

  it("throws TypeError on an invalid dataUpdatedAt", () => {
    expect(() => expiresAtFor("not-a-date", "congestion", "crowd")).toThrow(TypeError);
    // @ts-expect-error exercising the runtime guard with a non-string
    expect(() => expiresAtFor(undefined, "congestion", "crowd")).toThrow(TypeError);
  });

  it("throws TypeError on an unknown origin", () => {
    // @ts-expect-error exercising the runtime guard with an invalid origin
    expect(() => expiresAtFor("2026-07-11T12:00:00Z", "congestion", "nope")).toThrow(TypeError);
  });
});
