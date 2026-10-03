import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testFeed } from "../../__tests__/helpers/catalog.js";
import { clearReferenceCaches, loadReference } from "../reference.js";

const SITES = readFileSync(
  new URL(
    "../../../../../packages/roads/src/__tests__/fixtures/ndw-flow/measurement_site_table.xml",
    import.meta.url,
  ),
);

function flowFeed(sites: Record<string, unknown>) {
  return testFeed({
    id: "lu-test-flow",
    product: "flow",
    format: "datex2-measured",
    endpoints: {
      main: { url: "https://example.test/measured.xml", cadenceSec: 60 },
      sites: { decoder: "datex2-sites", cadenceSec: 60, ...sites },
    },
  });
}

function countingFetch() {
  return vi.fn(async () => new Response(new Uint8Array(SITES), { status: 200 }));
}

describe("loadReference — DATEX site tables", () => {
  beforeEach(() => clearReferenceCaches());

  it("the site table refreshes on its endpoint cadence", async () => {
    const feed = flowFeed({ url: "https://example.test/sites.xml" });
    const fetchFn = countingFetch();
    const t0 = Date.parse("2026-10-03T00:00:00Z");

    const first = await loadReference(feed, "sites", fetchFn as never, () => t0);
    expect((first as Map<string, unknown>).size).toBeGreaterThan(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await loadReference(feed, "sites", fetchFn as never, () => t0 + 30_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await loadReference(feed, "sites", fetchFn as never, () => t0 + 61_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns undefined (dormant) when the URL names an unset credential", async () => {
    const feed = flowFeed({ url: "https://example.test/${verortung_id}/sites.xml" });
    const fetchFn = countingFetch();
    const dormant = testFeed({
      ...feed,
      credentials: { verortung_id: { title: "Verortung subscription id" } },
    });
    expect(await loadReference(dormant, "sites", fetchFn as never, Date.now)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
