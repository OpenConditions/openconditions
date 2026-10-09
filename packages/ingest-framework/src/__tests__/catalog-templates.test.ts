import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sharedCredentialValue } from "../catalog/credentials.js";
import { toCatalogFeed } from "../catalog/resolve.js";
import {
  eachItemPath,
  resolveEachUrl,
  resolveEndpointUrls,
  resolveFeedTemplate,
  settingUrl,
} from "../catalog/templates.js";
import type { CatalogFeed } from "../catalog/types.js";
import { catalogFeed } from "./helpers/catalog-feed.js";

/** A feed reading the `overpass` group of settings, resolved as the loader resolves it. */
function settingsReader(url: string): CatalogFeed {
  return toCatalogFeed(
    {
      operator: "osm",
      product: "fuel",
      name: "OSM fuel",
      format: "overpass",
      tier: "authoritative",
      homepage: "https://www.openstreetmap.org",
      endpoints: { main: { url, cadenceSec: 3600 } },
      freshnessWindowSec: 7200,
      license: "ODbL-1.0",
      attribution: "OpenStreetMap contributors",
      privacyUrl: "https://example.test/privacy",
    },
    {
      domain: "fuel",
      region: "global",
      file: "feeds/fuel/global.jsonc",
      maintainers: [],
      shared: { overpass: { url: { title: "Overpass", default: "https://overpass.test/" } } },
    },
  );
}

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
    homepage: "https://m",
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

  test("a settings base URL with a trailing slash or the full interpreter path yields one interpreter URL", () => {
    const reader = settingsReader("${@overpass.url}/api/interpreter?q=1");
    const urls = (value: string) => resolveEndpointUrls(reader, "main", { OVERPASS_URL: value });
    for (const value of [
      "http://overpass:80",
      "http://overpass:80/",
      "http://overpass:80//",
      "http://overpass:80/api/interpreter",
      "http://overpass:80/api/interpreter/",
    ]) {
      expect(urls(value)).toEqual(["http://overpass:80/api/interpreter?q=1"]);
    }
    // Unset: the default, the public instance.
    expect(resolveEndpointUrls(reader, "main", {})).toEqual([
      "https://overpass.test/api/interpreter?q=1",
    ]);
    // A path that merely ends like the template's is no interpreter path.
    expect(urls("http://overpass:80/xapi/interpreter")).toEqual([
      "http://overpass:80/xapi/interpreter/api/interpreter?q=1",
    ]);
    // A setting the template appends no path to only loses its trailing slashes.
    expect(
      resolveEndpointUrls(settingsReader("${@overpass.url}"), "main", {
        OVERPASS_URL: "http://overpass:80/api/interpreter/",
      }),
    ).toEqual(["http://overpass:80/api/interpreter"]);
  });

  test("settingUrl joins a settings base URL, or the full URL it already is, to its path", () => {
    expect(settingUrl("http://overpass:80/", "/api/interpreter")).toBe(
      "http://overpass:80/api/interpreter",
    );
    expect(settingUrl("http://overpass:80/api/interpreter", "/api/interpreter")).toBe(
      "http://overpass:80/api/interpreter",
    );
    expect(settingUrl("http://overpass:80/api/", "/api/")).toBe("http://overpass:80/api/");
    expect(settingUrl("http://overpass:80/", "")).toBe("http://overpass:80");
  });

  test("a setting value with a query is no base URL holding the path: only trailing slashes go", () => {
    // A base URL carries no query or fragment; one that does is taken as written.
    expect(settingUrl("http://overpass:80/api/interpreter?x=1/", "/api/interpreter")).toBe(
      "http://overpass:80/api/interpreter?x=1/api/interpreter",
    );
    expect(settingUrl("http://overpass:80/api/interpreter#f", "/api/interpreter")).toBe(
      "http://overpass:80/api/interpreter#f/api/interpreter",
    );
  });

  test("a feed credential value ending in '/' is filled verbatim", () => {
    const feed = feedWith({
      main: { url: "${@mobilithek.base}/api/x?k=${api_key}", cadenceSec: 60 },
    });
    const env = {
      MOBILITHEK_BASE: "http://own:80/api/x/",
      DE_BY_MOBILITHEK_EVENTS_API_KEY: "k/",
    };
    expect(resolveEndpointUrls(feed, "main", env)).toEqual(["http://own:80/api/x//api/x?k=k/"]);
    const own = feedWith({ main: { url: "https://m/${api_key}/feed", cadenceSec: 60 } });
    expect(resolveEndpointUrls(own, "main", { DE_BY_MOBILITHEK_EVENTS_API_KEY: "a/" })).toEqual([
      "https://m/a//feed",
    ]);
  });

  test("a shared field's value outside any feed: its env var, else its default", () => {
    const groups = { overpass: { url: { title: "Overpass", default: "https://overpass.test" } } };
    expect(sharedCredentialValue(groups, "@overpass.url", {})).toBe("https://overpass.test");
    expect(sharedCredentialValue(groups, "@overpass.url", { OVERPASS_URL: "" })).toBe(
      "https://overpass.test",
    );
    expect(sharedCredentialValue(groups, "@overpass.url", { OVERPASS_URL: "http://own:80" })).toBe(
      "http://own:80",
    );
    expect(sharedCredentialValue({}, "@overpass.url", {})).toBeUndefined();
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

  describe("cell placeholders", () => {
    const cell = { id: "0.25/53/209", west: 13.25, south: 52.25, east: 13.5, north: 52.5 };

    test("cell placeholders fill url and body; credentials still resolve", () => {
      const feed = feedWith({
        main: {
          url: "https://h/list?lat={lat}&lng={lon}&rad={radiusKm}&apikey=${api_key}",
          method: "POST",
          body: "({south},{west},{north},{east})",
          cadenceSec: 60,
        },
      });
      const env = { DE_BY_MOBILITHEK_EVENTS_API_KEY: "k1" };
      const [url] = resolveEndpointUrls(feed, "main", env, cell);
      expect(url).toBe("https://h/list?lat=52.375&lng=13.375&rad=16.3&apikey=k1");
      expect(resolveFeedTemplate(feed, "({south},{west},{north},{east})", env, cell)).toBe(
        "(52.25,13.25,52.5,13.5)",
      );
    });

    test("a credential value that looks like a placeholder is not refilled", () => {
      const feed = feedWith({ main: { url: "https://h/?k=${api_key}&w={west}", cadenceSec: 60 } });
      expect(
        resolveEndpointUrls(feed, "main", { DE_BY_MOBILITHEK_EVENTS_API_KEY: "{lat}" }, cell),
      ).toEqual(["https://h/?k={lat}&w=13.25"]);
    });

    test("a brace that is not one of the seven names is left untouched", () => {
      const feed = feedWith();
      expect(resolveFeedTemplate(feed, '{"a":{"b":1},"c":{x}} {north}', {}, cell)).toBe(
        '{"a":{"b":1},"c":{x}} 52.5',
      );
    });

    test("without a cell the placeholders stay", () => {
      expect(resolveFeedTemplate(feedWith(), "{lat}", {})).toBe("{lat}");
    });
  });

  describe("utcDate placeholders", () => {
    const at = Date.parse("2026-10-08T23:59:59Z");

    test("fill the poll instant's UTC date, or a day before it", () => {
      const feed = feedWith({
        main: {
          urls: [
            "https://dd.test/{utcDate-1}/alerts/{utcDate-1}/",
            "https://dd.test/{utcDate}/alerts/{utcDate}/",
          ],
          cadenceSec: 120,
        },
      });
      expect(resolveEndpointUrls(feed, "main", {}, undefined, at)).toEqual([
        "https://dd.test/20261007/alerts/20261007/",
        "https://dd.test/20261008/alerts/20261008/",
      ]);
      expect(
        resolveEndpointUrls(feed, "main", {}, undefined, Date.parse("2026-10-09T00:00:00Z")),
      ).toEqual([
        "https://dd.test/20261008/alerts/20261008/",
        "https://dd.test/20261009/alerts/20261009/",
      ]);
      expect(resolveFeedTemplate(feed, "{utcDate-7}", {}, undefined, at)).toBe("20261001");
      // Across a month and a year boundary.
      expect(
        resolveFeedTemplate(feed, "{utcDate-1}", {}, undefined, Date.parse("2027-01-01T00:30Z")),
      ).toBe("20261231");
    });

    test("go in the same pass as credentials, so a credential's value is never read for one", () => {
      const feed = feedWith({ main: { url: "https://m/{utcDate}?k=${api_key}", cadenceSec: 60 } });
      expect(
        resolveEndpointUrls(
          feed,
          "main",
          { DE_BY_MOBILITHEK_EVENTS_API_KEY: "{utcDate}" },
          undefined,
          at,
        ),
      ).toEqual(["https://m/20261008?k={utcDate}"]);
    });
  });

  describe("per-item urls", () => {
    const feed = catalogFeed({
      endpoints: {
        alerts: { url: "https://api.test/alerts", cadenceSec: 120 },
        zones: {
          url: "https://api.test/zones/{item}?at={utcDate}",
          cadenceSec: 120,
          each: { role: "alerts", records: "features", field: "zones" },
        },
      },
    });
    const at = Date.parse("2026-10-08T12:00:00Z");

    test("encode each segment and keep the slashes between them", () => {
      expect(resolveEachUrl(feed, "zones", "forecast/WYZ001", {}, at)).toBe(
        "https://api.test/zones/forecast/WYZ001?at=20261008",
      );
      expect(resolveEachUrl(feed, "zones", "a b/c&d", {}, at)).toBe(
        "https://api.test/zones/a%20b/c%26d?at=20261008",
      );
      // An item never names a placeholder.
      expect(resolveEachUrl(feed, "zones", "{utcDate}", {}, at)).toBe(
        "https://api.test/zones/%7ButcDate%7D?at=20261008",
      );
    });

    test("refuse an item that would leave its path", () => {
      for (const item of ["forecast/../x", "..", "./x", "a//b", "/a", "a/", "a?b", "a#b", "a\\b"]) {
        expect(eachItemPath(item)).toBeUndefined();
        expect(() => resolveEachUrl(feed, "zones", item, {}, at)).toThrow(/refused/);
      }
      expect(eachItemPath("forecast/WYZ001")).toBe("forecast/WYZ001");
    });
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
