import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveEndpointUrls } from "../catalog/templates.js";
import type { CatalogFeed } from "../catalog/types.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

const MOBILITHEK = {
  main: {
    url: "https://m/${subscription_id}",
    expand: "subscription_id",
    cadenceSec: 300,
  },
};

function feedWith(endpoints: CatalogFeed["endpoints"] = MOBILITHEK): CatalogFeed {
  return catalogFeed({
    region: "de",
    subdivision: "by",
    operator: "mobilithek",
    product: "events",
    credentials: {
      subscription_id: { title: "Subscription id" },
      api_key: { title: "API key" },
      region_code: { title: "Region code", default: "north" },
    },
    endpoints,
  });
}

describe("resolveEndpointUrls", () => {
  test("expand fans out one url per comma item", () => {
    const env = { DE_BY_MOBILITHEK_EVENTS_SUBSCRIPTION_ID: "11,22" };
    expect(resolveEndpointUrls(feedWith(), "main", env)).toEqual(["https://m/11", "https://m/22"]);
  });

  test("an empty expand value makes the feed dormant", () => {
    expect(
      resolveEndpointUrls(feedWith(), "main", { DE_BY_MOBILITHEK_EVENTS_SUBSCRIPTION_ID: "" }),
    ).toEqual([]);
    expect(resolveEndpointUrls(feedWith(), "main", {})).toEqual([]);
  });

  test("a template may only name the feed's credentials", () => {
    expect(() =>
      resolveEndpointUrls(
        feedWith({ main: { url: "https://m/${HOME}", cadenceSec: 60 } }),
        "main",
        {
          HOME: "/root",
        },
      ),
    ).toThrow(/not a credential/);
    expect(() =>
      resolveEndpointUrls(
        feedWith({ main: { url: "https://m/${undeclared}", cadenceSec: 60 } }),
        "main",
        { DE_BY_MOBILITHEK_EVENTS_UNDECLARED: "x" },
      ),
    ).toThrow(/not a credential/);
  });

  test("expand trims items, repeats every template and fills the id in path and query", () => {
    const feed = feedWith({
      main: {
        urls: [
          "https://m/a/${subscription_id}?subscriptionID=${subscription_id}",
          "https://m/b/${subscription_id}",
        ],
        expand: "subscription_id",
        cadenceSec: 300,
      },
    });
    expect(
      resolveEndpointUrls(feed, "main", { DE_BY_MOBILITHEK_EVENTS_SUBSCRIPTION_ID: " 1, 2 ," }),
    ).toEqual([
      "https://m/a/1?subscriptionID=1",
      "https://m/b/1",
      "https://m/a/2?subscriptionID=2",
      "https://m/b/2",
    ]);
  });

  test("a field resolves from its derived env var, its _FILE variant or its default", () => {
    const feed = feedWith({
      main: { url: "https://m/${region_code}?k=${api_key}", cadenceSec: 60 },
    });
    expect(resolveEndpointUrls(feed, "main", { DE_BY_MOBILITHEK_EVENTS_API_KEY: "k1" })).toEqual([
      "https://m/north?k=k1",
    ]);

    const dir = mkdtempSync(join(tmpdir(), "oc-templates-"));
    const file = join(dir, "key");
    writeFileSync(file, "from-file\n");
    expect(
      resolveEndpointUrls(feed, "main", {
        DE_BY_MOBILITHEK_EVENTS_API_KEY_FILE: file,
        DE_BY_MOBILITHEK_EVENTS_REGION_CODE: "south",
      }),
    ).toEqual(["https://m/south?k=from-file"]);
  });

  test("an unset credential in a template throws naming its env var", () => {
    const feed = feedWith({ main: { url: "https://m/?k=${api_key}", cadenceSec: 60 } });
    expect(() => resolveEndpointUrls(feed, "main", {})).toThrow(/DE_BY_MOBILITHEK_EVENTS_API_KEY/);
  });

  test("a shared credential resolves from its group's env var", () => {
    const feed = feedWith({ main: { url: "https://m/?k=${@mobilithek.token}", cadenceSec: 60 } });
    expect(resolveEndpointUrls(feed, "main", { MOBILITHEK_TOKEN: "t" })).toEqual([
      "https://m/?k=t",
    ]);
  });

  test("a catalogue child resolves through its parent's names", () => {
    const child = catalogFeed({
      ...feedWith({ main: { url: "https://m/?k=${api_key}", cadenceSec: 60 } }),
      id: "de-by-mobilithek-a1-events",
      parentSourceId: "de-by-mobilithek-events",
    });
    expect(resolveEndpointUrls(child, "main", { DE_BY_MOBILITHEK_EVENTS_API_KEY: "p" })).toEqual([
      "https://m/?k=p",
    ]);
  });

  test("a static url passes through unchanged", () => {
    const feed = feedWith({ main: { url: "https://m/static.xml", cadenceSec: 60 } });
    expect(resolveEndpointUrls(feed, "main", {})).toEqual(["https://m/static.xml"]);
  });

  test("an unknown role or a reference endpoint has no url", () => {
    expect(() => resolveEndpointUrls(feedWith(), "sites", {})).toThrow(/no endpoint sites/);
    const feed = feedWith({
      main: { url: "https://m/x", cadenceSec: 60 },
      sites: {
        reference: { kind: "mobilithek", offerId: "1", fileNamePrefix: "x" },
        decoder: "datex2-sites",
        cadenceSec: 3600,
      },
    });
    expect(() => resolveEndpointUrls(feed, "sites", {})).toThrow(/reference/);
  });
});
