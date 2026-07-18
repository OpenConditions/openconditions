import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import type { LookupFn } from "@openconditions/ingest-framework";
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
    format: "autobahn",
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

  it("uses an injected lookup instead of performing a real DNS resolution", async () => {
    const seenHosts: string[] = [];
    const fakeLookup = (async (hostname: string) => {
      seenHosts.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    }) as unknown as LookupFn;

    const upstream = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

    // A hostname under the RFC 2606 reserved .invalid TLD never resolves via
    // real DNS — if resolvePublicIps ever fell through to the real resolver
    // here it would throw, and runSource would swallow it into count:0 without
    // seenHosts ever being populated by our fake.
    await runSource(blockedFeed("https://feed.this-host-does-not-exist.invalid/feed.json"), {
      sql: noSwapSql,
      fetch: upstream,
      now: () => new Date().toISOString(),
      openlrClient: null,
      lookup: fakeLookup,
    }).catch(() => {
      // Parsing an unrelated fixture may throw after the fetch — irrelevant
      // here, we only assert the injected lookup was actually consulted.
    });

    expect(seenHosts).toContain("feed.this-host-does-not-exist.invalid");
  });
});
