import { describe, expect, it, vi } from "vitest";
import { FeedStatusStore } from "../feed-status.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { scheduleFeed } from "../scheduler.js";
import { repoFeed } from "./helpers/catalog.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

describe("a feed slower than an hour", () => {
  it("is scheduled on an hourly tick, which cron can express", () => {
    const vienna = repoFeed("at-9-vienna-parking");
    expect(vienna.cadenceSec).toBe(604_800);
    const sql = {} as never;
    const job = scheduleFeed(vienna, {
      sql,
      statusStore: new FeedStatusStore(),
      deps: { sql, fetch: vi.fn(), now: () => "2026-10-05T00:00:00.000Z" },
      env: {},
    });
    try {
      expect(job).toBeDefined();
      const next = job?.nextRun()?.getTime() ?? Number.POSITIVE_INFINITY;
      expect(next - Date.now()).toBeLessThanOrEqual(HOUR_MS);
    } finally {
      job?.stop();
    }
  });

  it("is not polled again on a tick before its cadence ends", async () => {
    const vienna = repoFeed("at-9-vienna-parking");
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    const roles = createRoleState();
    roles.lastFetchedAt["main"] = now - 4 * DAY_MS;
    const fetch = vi.fn();
    const result = await runSource(vienna, {
      sql: {} as never,
      fetch,
      now: () => new Date(now).toISOString(),
      roles,
    });
    expect(result).toEqual({ count: 0, durationMs: 0, notDue: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is polled on the tick its cadence ends", () => {
    const vienna = repoFeed("at-9-vienna-parking");
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    const roles = createRoleState();
    roles.lastFetchedAt["main"] = now - 7 * DAY_MS + 60_000;
    const sql = vi.fn(() => {
      throw new Error("polled");
    });
    return expect(
      runSource(vienna, {
        sql: sql as never,
        fetch: vi.fn(),
        now: () => new Date(now).toISOString(),
        roles,
      }),
    ).rejects.toThrow();
  });
});
