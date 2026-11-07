import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { smnLinks } from "../smn-rss.js";

const root = new URL("../../../hazards/src/__tests__/fixtures/smn/", import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, root));
const at = Date.parse("2026-11-07T15:48:00Z");
describe("SMN RSS discovery", () => {
  it("validates the ordinary index and deduplicates official sibling CAP links", () => {
    const links = smnLinks(fixture("ar-rss.xml"), "ar", at);
    expect(links.length).toBeGreaterThan(10);
    expect(new Set(links).size).toBe(links.length);
    expect(
      links.every((url) => url.startsWith("https://ssl.smn.gob.ar/feeds/CAP/xml_generados/")),
    ).toBe(true);
  });
  it("accounts the ACP sentinel as zero without following its HTML link", () => {
    expect(smnLinks(fixture("acp-rss.xml"), "acp", at)).toEqual([]);
    expect(() => smnLinks(fixture("acp-rss.xml"), "ar", at)).toThrow();
  });
  it("refuses frozen, HTML, malformed and escaped-path indexes", () => {
    expect(() => smnLinks(fixture("ar-rss.xml"), "ar", at + 3 * 86400000)).toThrow();
    for (const text of [
      "<html>maintenance</html>",
      "<rss>",
      fixture("ar-rss.xml").toString().replaceAll("/feeds/CAP/xml_generados/", "/private/"),
    ]) {
      expect(() => smnLinks(Buffer.from(text), "ar", at)).toThrow();
    }
  });
});

it("revalidates unversioned children even on index 304 and stages validators until acceptance", async () => {
  const { createFetchState, fetchEndpoint } = await import("../fetch.js");
  const { catalogFeed } = await import("./helpers/catalog-feed.js");
  const indexUrl = "https://ssl.smn.gob.ar/CAP/AR.php";
  const childUrl = "https://ssl.smn.gob.ar/feeds/CAP/xml_generados/CAP_test.xml";
  const feed = catalogFeed({
    domain: "hazards",
    format: "cap",
    endpoints: { alerts: { url: indexUrl, smnRss: "ar", cadenceSec: 180 } },
  });
  const index = `<rss version="2.0"><channel><lastBuildDate>Sat, 07 Nov 2026 15:48:00 GMT</lastBuildDate><copyright>Licencia CC BY 4.0</copyright><item><link>${childUrl}</link></item><item><link>${childUrl}</link></item></channel></rss>`;
  const state = createFetchState();
  const calls: { url: string; conditional: string | null }[] = [];
  let unchanged = false;
  let fail = false;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      conditional: new Headers(init?.headers).get("if-none-match"),
    });
    if (fail && String(input) === childUrl) return new Response("failure", { status: 503 });
    return unchanged
      ? new Response(null, { status: 304 })
      : new Response(String(input) === indexUrl ? index : "CAP bytes", { headers: { etag: "v1" } });
  }) as typeof globalThis.fetch;
  const first = await fetchEndpoint(feed, "alerts", fetch, { state, at });
  expect(first.status).toBe("fetched");
  expect(state.conditional.size).toBe(0);
  if (first.status !== "fetched") throw new Error(first.status);
  first.accept();
  unchanged = true;
  const next = await fetchEndpoint(feed, "alerts", fetch, { state, at: at + 180000 });
  expect(next.status).toBe("fetched");
  expect(calls.map((c) => c.url)).toEqual([indexUrl, childUrl, indexUrl, childUrl]);
  expect(calls.slice(2).every((c) => c.conditional === "v1")).toBe(true);
  if (next.status !== "fetched") throw new Error(next.status);
  expect(next.bodyFreshness).toBe("held");
  expect(next.buffers[0]!.toString()).toBe("CAP bytes");
  fail = true;
  await expect(fetchEndpoint(feed, "alerts", fetch, { state, at: at + 360000 })).rejects.toThrow(
    "503",
  );
  expect(state.conditional.size).toBe(2);
  await expect(
    fetchEndpoint(feed, "alerts", fetch, { state, at: at + 3 * 86400000 }),
  ).rejects.toThrow("stale");
});

it("returns an accounted ACP zero without requesting the sentinel HTML target", async () => {
  const { fetchEndpoint, createFetchState } = await import("../fetch.js");
  const { catalogFeed } = await import("./helpers/catalog-feed.js");
  const calls: string[] = [];
  const feed = catalogFeed({
    domain: "hazards",
    format: "cap",
    endpoints: {
      alerts: {
        url: "https://ssl.smn.gob.ar/feeds/CAP/avisocortoplazo/rss_acpCAP.xml",
        cadenceSec: 180,
        smnRss: "acp",
      },
    },
  });
  const result = await fetchEndpoint(
    feed,
    "alerts",
    (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(fixture("acp-rss.xml"));
    }) as typeof fetch,
    { state: createFetchState(), at },
  );
  expect(result.status).toBe("fetched");
  if (result.status !== "fetched") throw new Error(result.status);
  expect(result.buffers).toEqual([]);
  expect(result.partitions).toEqual({ succeeded: 1, failed: 0, total: 1 });
  expect(calls).toEqual([feed.endpoints["alerts"]!.url]);
});
