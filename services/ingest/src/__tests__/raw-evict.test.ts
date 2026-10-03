import { describe, expect, it } from "vitest";
import { type EvictionPolicy, type HeldPayload, planEviction } from "../raw/evict.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const policy = (over: Partial<EvictionPolicy> = {}): EvictionPolicy => ({
  now: NOW,
  hotHours: 48,
  thinDays: { situation: 14, observation: 7 },
  maxBytes: 0,
  ...over,
});

let n = 0;
/** A payload last seen `hoursAgo` ago. */
function payload(
  sourceId: string,
  tier: HeldPayload["tier"],
  hoursAgo: number,
  over: Partial<HeldPayload> = {},
): HeldPayload {
  n += 1;
  return {
    sourceId,
    hash: `h${n}`,
    tier,
    lastSeenAt: NOW - hoursAgo * HOUR,
    bytesStored: 100,
    protected: false,
    ...over,
  };
}

/** A source's payloads every `stepMinutes` back to `hours` ago. */
function series(sourceId: string, tier: HeldPayload["tier"], hours: number, stepMinutes = 30) {
  const out: HeldPayload[] = [];
  for (let m = 0; m <= hours * 60; m += stepMinutes) out.push(payload(sourceId, tier, m / 60));
  return out;
}

const ages = (rows: HeldPayload[]) => rows.map((r) => (NOW - r.lastSeenAt) / HOUR);

describe("planEviction without a cap", () => {
  it("keeps every payload of the hot window, then one per hour until the tier's thinned window ends", () => {
    const rows = series("nl-ndw-events", "situation", 20 * 24);
    const { evict, rung } = planEviction(rows, policy());
    expect(rung).toBe(0);
    const kept = rows.filter((r) => !evict.includes(r));
    expect(ages(kept).filter((a) => a <= 48)).toHaveLength(97);
    expect(ages(kept).filter((a) => a > 48)).toHaveLength(14 * 24 - 48);
    expect(Math.max(...ages(kept))).toBeLessThanOrEqual(14 * 24);
  });

  it("thins observation feeds over a shorter window", () => {
    const rows = series("nl-ndw-flow", "observation", 10 * 24);
    const kept = rows.filter((r) => !planEviction(rows, policy()).evict.includes(r));
    expect(Math.max(...ages(kept))).toBeLessThanOrEqual(7 * 24);
  });

  it("keeps only the hot window of a hot-only source, and the newest three of a reference table", () => {
    const hot = series("ca-bc-drivebc-events", "hot", 72, 60);
    const reference = [100, 200, 300, 400, 500].map((h) => payload("nl-ndw-flow", "reference", h));
    const { evict } = planEviction([...hot, ...reference], policy());
    expect(ages(evict.filter((r) => r.tier === "hot"))).toEqual(
      ages(hot.filter((r) => NOW - r.lastSeenAt > 48 * HOUR)),
    );
    expect(ages(evict.filter((r) => r.tier === "reference"))).toEqual([400, 500]);
  });

  it("never evicts a source's newest three or a protected payload, however old", () => {
    const old = [500, 600, 700, 800].map((h) => payload("old-src", "hot", h));
    const pinned = payload("old-src", "hot", 900, { protected: true });
    const { evict } = planEviction([...old, pinned], policy());
    expect(ages(evict)).toEqual([800]);
  });
});

describe("planEviction over the cap", () => {
  const situation = series("nl-ndw-events", "situation", 14 * 24, 60);
  const observation = series("nl-ndw-flow", "observation", 7 * 24, 60);
  const all = [...situation, ...observation];
  const keptBytes = (cap: number) => {
    const { evict } = planEviction(all, policy({ maxBytes: cap }));
    return all.length * 100 - evict.length * 100;
  };

  it("shortens the observation feeds' thinned window before the situation feeds'", () => {
    const { evict, rung } = planEviction(all, policy({ maxBytes: (all.length - 30) * 100 }));
    expect(rung).toBe(1);
    expect(evict.every((r) => r.tier === "observation")).toBe(true);
    expect(keptBytes((all.length - 30) * 100)).toBeLessThanOrEqual((all.length - 30) * 100);
  });

  it("thins further before it touches the hot window", () => {
    const hotOnly = all.filter((r) => NOW - r.lastSeenAt <= 48 * HOUR).length;
    const { rung, hotEvicted } = planEviction(all, policy({ maxBytes: (hotOnly + 10) * 100 }));
    expect(rung).toBe(2);
    expect(hotEvicted).toEqual([]);
  });

  it("cuts into the hot window only last, observation feeds first, and says whose", () => {
    const { rung, hotEvicted, evict } = planEviction(all, policy({ maxBytes: 40 * 100 }));
    expect(rung).toBe(3);
    expect(hotEvicted).toContain("nl-ndw-flow");
    expect(all.length - evict.length).toBeGreaterThanOrEqual(6);
  });

  it("drops what is left of the thinned windows before it cuts into any hot window", () => {
    const situationFeed = [0, 1, 2, 60].map((h) => payload("nl-ndw-events", "situation", h));
    const observationFeed = [0, 1, 2, 10, 20].map((h) => payload("nl-ndw-flow", "observation", h));
    const rows = [...situationFeed, ...observationFeed];
    const { evict, rung, hotEvicted } = planEviction(rows, policy({ maxBytes: 800 }));
    expect(evict).toEqual([situationFeed[3]]);
    expect(rung).toBe(2);
    expect(hotEvicted).toEqual([]);
  });

  it("names only the sources that lost a hot-window payload", () => {
    const situationFeed = [0, 1, 2, 60].map((h) => payload("nl-ndw-events", "situation", h));
    const observationFeed = [0, 1, 2, 10, 20].map((h) => payload("nl-ndw-flow", "observation", h));
    const { evict, rung, hotEvicted } = planEviction(
      [...situationFeed, ...observationFeed],
      policy({ maxBytes: 700 }),
    );
    expect(evict).toEqual([situationFeed[3], observationFeed[4]]);
    expect(rung).toBe(3);
    expect(hotEvicted).toEqual(["nl-ndw-flow"]);
  });

  it("plans a large archive in linear time per source", () => {
    const rows = series("nl-ndw-flow", "observation", 48, 0.1);
    expect(rows.length).toBeGreaterThan(28_000);
    const started = performance.now();
    planEviction(rows, policy({ maxBytes: 100 * 100 }));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("keeps a pinned payload even when nothing else fits under the cap", () => {
    const pinned = payload("nl-ndw-events", "situation", 10, { protected: true });
    const { evict, rung } = planEviction([...all, pinned], policy({ maxBytes: 1 }));
    expect(rung).toBe(3);
    expect(evict).not.toContain(pinned);
  });
});
