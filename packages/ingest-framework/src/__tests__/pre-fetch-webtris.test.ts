import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRE_FETCH_HOOKS,
  WEBTRIS_MAX_SITES,
  clearWebtrisSitesCache,
  loadWebtrisActiveSiteIds,
} from "../pre-fetch.js";
import type { FeedSourceBase } from "../feed-source.js";

const noFetch = (async () => new Response("")) as unknown as typeof fetch;

const REGISTRY_URL = "https://webtris.nationalhighways.co.uk/api/v1.0/sites";

function sitesFetch(sites: { Id: string; Status: string }[]): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url) === REGISTRY_URL) {
      return new Response(JSON.stringify({ sites }), { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

const multiSiteSrc = {
  id: "webtris-gb",
  name: "WebTRIS",
  format: "webtris-json",
  cadenceSec: 900,
  freshnessWindowSec: 3600,
  license: "OGL-UK-3.0",
  attribution: "National Highways",
  country: "GB",
  privacyUrl: "https://x",
  enabledByDefault: true,
  url: "https://webtris.nationalhighways.co.uk/api/v1.0/reports/daily?sites={sites}&start_date={start_date}&end_date={end_date}&page=1&page_size=100",
  stationRegistry: { url: REGISTRY_URL, format: "webtris-sites" },
} as unknown as FeedSourceBase;

describe("webtrisDailyWindow preFetch", () => {
  it("is registered on the shared PRE_FETCH_HOOKS registry", () => {
    expect(PRE_FETCH_HOOKS["webtrisDailyWindow"]).toBeTypeOf("function");
  });

  it("stamps a rolling DDMMYYYY window into the url, replacing both tokens", async () => {
    const hook = PRE_FETCH_HOOKS["webtrisDailyWindow"]!;
    const src = {
      id: "webtris-gb",
      name: "WebTRIS",
      format: "webtris-json",
      cadenceSec: 900,
      freshnessWindowSec: 3600,
      license: "OGL-UK-3.0",
      attribution: "National Highways",
      country: "GB",
      privacyUrl: "https://x",
      enabledByDefault: true,
      url: "https://webtris.nationalhighways.co.uk/api/v1.0/reports/daily?sites=5607&start_date={start_date}&end_date={end_date}&page=1&page_size=100",
    } as FeedSourceBase;

    const out = await hook(src, {}, noFetch);
    const url = out.url as string;

    expect(url).not.toContain("{start_date}");
    expect(url).not.toContain("{end_date}");
    expect(url).toMatch(/start_date=\d{8}/);
    expect(url).toMatch(/end_date=\d{8}/);
  });

  it("stamps end_date as today (UTC) and start_date as the prior day", async () => {
    const hook = PRE_FETCH_HOOKS["webtrisDailyWindow"]!;
    const src = {
      id: "webtris-gb",
      name: "WebTRIS",
      format: "webtris-json",
      cadenceSec: 900,
      freshnessWindowSec: 3600,
      license: "OGL-UK-3.0",
      attribution: "National Highways",
      country: "GB",
      privacyUrl: "https://x",
      enabledByDefault: true,
      url: "https://x.test/?start_date={start_date}&end_date={end_date}",
    } as FeedSourceBase;

    const now = new Date();
    const ddmmyyyy = (d: Date) =>
      `${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${d.getUTCFullYear()}`;
    const expectedEnd = ddmmyyyy(now);
    const expectedStart = ddmmyyyy(new Date(now.getTime() - 86_400_000));

    const out = await hook(src, {}, noFetch);
    expect(out.url).toBe(`https://x.test/?start_date=${expectedStart}&end_date=${expectedEnd}`);
  });

  it("leaves non-string urls untouched", async () => {
    const hook = PRE_FETCH_HOOKS["webtrisDailyWindow"]!;
    const src = {
      id: "webtris-gb",
      name: "WebTRIS",
      format: "webtris-json",
      cadenceSec: 900,
      freshnessWindowSec: 3600,
      license: "OGL-UK-3.0",
      attribution: "National Highways",
      country: "GB",
      privacyUrl: "https://x",
      enabledByDefault: true,
    } as FeedSourceBase;

    const out = await hook(src, {}, noFetch);
    expect(out).toBe(src);
  });
});

describe("webtrisDailyWindow {sites} fan-out", () => {
  beforeEach(() => {
    clearWebtrisSitesCache();
  });

  it("fans {sites} out to only Active sites, one per URL, with dates stamped and no leftover tokens", async () => {
    const hook = PRE_FETCH_HOOKS["webtrisDailyWindow"]!;
    const fetchFn = sitesFetch([
      { Id: "1", Status: "Active" },
      { Id: "2", Status: "Inactive" },
      { Id: "3", Status: "Active" },
    ]);

    const out = await hook(multiSiteSrc, {}, fetchFn);
    const urls = out.url as string[];

    expect(Array.isArray(urls)).toBe(true);
    expect(urls).toHaveLength(2);
    for (const u of urls) {
      expect(u).not.toContain("{sites}");
      expect(u).not.toContain("{start_date}");
      expect(u).not.toContain("{end_date}");
      expect(u).toMatch(/start_date=\d{8}/);
      expect(u).toMatch(/end_date=\d{8}/);
    }
    expect(urls.some((u) => u.includes("sites=1"))).toBe(true);
    expect(urls.some((u) => u.includes("sites=3"))).toBe(true);
    expect(urls.some((u) => u.includes("sites=2"))).toBe(false);
  });

  it("bounds the number of fanned-out urls to WEBTRIS_MAX_SITES", async () => {
    const hook = PRE_FETCH_HOOKS["webtrisDailyWindow"]!;
    const many = Array.from({ length: WEBTRIS_MAX_SITES + 50 }, (_, i) => ({
      Id: String(i + 1),
      Status: "Active",
    }));

    const out = await hook(multiSiteSrc, {}, sitesFetch(many));
    const urls = out.url as string[];

    expect(urls).toHaveLength(WEBTRIS_MAX_SITES);
  });

  it("falls back to a single default site, with no unresolved token, when the sites fetch throws", async () => {
    const hook = PRE_FETCH_HOOKS["webtrisDailyWindow"]!;
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const out = await hook(multiSiteSrc, {}, throwingFetch);
    const urls = out.url as string[];

    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain("{sites}");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to a single default site when the sites response has zero active sites", async () => {
    const hook = PRE_FETCH_HOOKS["webtrisDailyWindow"]!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const out = await hook(multiSiteSrc, {}, sitesFetch([{ Id: "1", Status: "Inactive" }]));
    const urls = out.url as string[];

    expect(urls).toHaveLength(1);
    expect(urls[0]).not.toContain("{sites}");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sends the feed's requestHeaders on the /sites fetch", async () => {
    const seen: (RequestInit | undefined)[] = [];
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ sites: [{ Id: "9", Status: "Active" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const hook = PRE_FETCH_HOOKS["webtrisDailyWindow"]!;
    const srcWithHeaders = { ...multiSiteSrc, requestHeaders: { "X-Test": "1" } };

    await hook(srcWithHeaders, {}, fetchFn);

    expect(seen[0]?.headers).toEqual({ "X-Test": "1" });
  });
});

describe("loadWebtrisActiveSiteIds caching", () => {
  beforeEach(() => {
    clearWebtrisSitesCache();
  });

  it("does not refetch /sites within the TTL", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ sites: [{ Id: "1", Status: "Active" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    const clock = () => now;

    const first = await loadWebtrisActiveSiteIds(REGISTRY_URL, undefined, fetchFn, clock);
    now += 60_000; // well within the 6h TTL
    const second = await loadWebtrisActiveSiteIds(REGISTRY_URL, undefined, fetchFn, clock);

    expect(first).toEqual(["1"]);
    expect(second).toEqual(["1"]);
    expect(calls).toBe(1);
  });

  it("refetches /sites once the TTL has elapsed", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ sites: [{ Id: "1", Status: "Active" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    let now = 1_000_000;
    const clock = () => now;

    await loadWebtrisActiveSiteIds(REGISTRY_URL, undefined, fetchFn, clock);
    now += 7 * 60 * 60 * 1000; // past the 6h TTL
    await loadWebtrisActiveSiteIds(REGISTRY_URL, undefined, fetchFn, clock);

    expect(calls).toBe(2);
  });
});
