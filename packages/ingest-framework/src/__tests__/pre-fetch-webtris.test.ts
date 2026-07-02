import { describe, expect, it } from "vitest";
import { PRE_FETCH_HOOKS } from "../pre-fetch.js";
import type { FeedSourceBase } from "../feed-source.js";

const noFetch = (async () => new Response("")) as unknown as typeof fetch;

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
