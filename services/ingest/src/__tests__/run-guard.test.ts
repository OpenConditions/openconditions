import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { DomainFeedSource } from "../pipeline/run.js";
import { runSource } from "../pipeline/run.js";

/** A sql double whose transaction opener throws if the pipeline ever reaches the swap. */
const noSwapSql = Object.assign(
  ((..._args: unknown[]) => Promise.resolve([])) as unknown as Record<string, unknown>,
  {
    begin: async () => {
      throw new Error("atomicSwap opened a transaction for a blocked feed");
    },
  }
) as unknown as postgres.Sql;

function blockedFeed(url: string): DomainFeedSource {
  return {
    domain: "roads",
    id: "blocked",
    name: "blocked",
    format: "autobahn-json",
    cadenceSec: 300,
    freshnessWindowSec: 900,
    license: "test",
    attribution: "test",
    country: "XX",
    privacyUrl: "https://example.test/privacy",
    enabledByDefault: false,
    url,
  } as DomainFeedSource;
}

describe("runSource egress guard", () => {
  it("blocks a feed pointing at the metadata IP and preserves last-good (no swap)", async () => {
    const upstream = (async () =>
      new Response("secret", { status: 200 })) as unknown as typeof fetch;
    const res = await runSource(blockedFeed("http://169.254.169.254/latest/meta-data"), {
      sql: noSwapSql,
      fetch: upstream,
      now: () => new Date().toISOString(),
      openlrClient: null,
    });
    expect(res.count).toBe(0);
  });
});
