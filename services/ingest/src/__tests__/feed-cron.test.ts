import { Cron } from "croner";
import { describe, expect, it } from "vitest";
import { feedCron } from "../scheduler.js";

/** The next `n` ticks of a pattern after `from`, as epoch ms. */
function ticks(pattern: string, from: Date, n: number): number[] {
  const out: number[] = [];
  let at = from;
  for (let i = 0; i < n; i++) {
    const next = new Cron(pattern, { paused: true }).nextRun(at)!;
    out.push(next.getTime());
    at = next;
  }
  return out;
}

const gaps = (times: number[]) => times.slice(1).map((t, i) => (t - times[i]!) / 1000);
const FROM = new Date("2026-10-11T00:00:30Z");

describe("feedCron", () => {
  it("keeps each feed's cadence, its ticks set off the minute", () => {
    for (const [id, cadenceSec, gap] of [
      ["de-hh-polizei-events", 300, 300],
      ["fr-dir-flow", 360, 360],
      ["nasa-firms-modis-fires", 3600, 3600],
      ["es-dgt-charging", 86_400, 3600],
    ] as const) {
      const pattern = feedCron(id, cadenceSec);
      expect(gaps(ticks(pattern, FROM, 6)).every((g) => g === gap)).toBe(true);
    }
  });

  it("gives a feed the same ticks on every start and spreads the feeds apart", () => {
    expect(feedCron("lu-cita-events", 300)).toBe(feedCron("lu-cita-events", 300));
    const firsts = new Set(
      Array.from({ length: 40 }, (_, i) => ticks(feedCron(`xx-feed-${i}`, 300), FROM, 1)[0]),
    );
    expect(firsts.size).toBeGreaterThan(30);
  });

  it("leaves a sub-minute cadence on its own seconds step", () => {
    expect(feedCron("xx-fast", 30)).toBe("*/30 * * * * *");
  });
});
