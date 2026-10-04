import { describe, expect, test } from "vitest";
import { z } from "zod";
import { toCatalogFeed } from "../catalog/resolve.js";
import { feedBaseShape } from "../catalog/schema.js";
import type { FeedDefinition } from "../catalog/types.js";

const def: FeedDefinition = {
  operator: "ndw",
  product: "events",
  name: "NDW",
  format: "datex2",
  tier: "authoritative",
  endpoints: { main: { url: "https://opendata.ndw.nu/a/b.xml.gz", cadenceSec: 60 } },
  freshnessWindowSec: 600,
  license: "CC0-1.0",
  attribution: "NDW",
  privacyUrl: "https://p.example",
};

const origin = {
  domain: "roads",
  region: "nl",
  file: "feeds/roads/nl.jsonc",
  maintainers: [],
};

const withUrl = (url: string, extra: Partial<FeedDefinition> = {}): FeedDefinition => ({
  ...def,
  ...extra,
  endpoints: { main: { url, cadenceSec: 60 } },
});

describe("feed homepage", () => {
  test("defaults to the origin of the first data endpoint", () => {
    expect(toCatalogFeed(def, origin).homepage).toBe("https://opendata.ndw.nu");
  });

  test("an explicit default port is dropped", () => {
    expect(toCatalogFeed(withUrl("https://h.example:443/x"), origin).homepage).toBe(
      "https://h.example",
    );
  });

  test("a non-default port or a plain http host needs a written homepage", () => {
    expect(() => toCatalogFeed(withUrl("https://h.example:8443/x"), origin)).toThrow(
      /written homepage/,
    );
    expect(() => toCatalogFeed(withUrl("http://h.example/x"), origin)).toThrow(/written homepage/);
    expect(
      toCatalogFeed(
        withUrl("https://h.example:8443/x", { homepage: "https://www.h.example" }),
        origin,
      ).homepage,
    ).toBe("https://www.h.example");
  });

  test("reference data endpoints are skipped", () => {
    const feed = toCatalogFeed(
      {
        ...def,
        endpoints: {
          sites: { url: "https://ref.example/sites", decoder: "datex2-sites", cadenceSec: 600 },
          main: { url: "https://data.example/events", cadenceSec: 60 },
        },
      },
      origin,
    );
    expect(feed.homepage).toBe("https://data.example");
  });

  test("a url list uses its first entry", () => {
    const feed = toCatalogFeed(
      {
        ...def,
        endpoints: {
          main: { urls: ["https://one.example/a", "https://two.example/b"], cadenceSec: 60 },
        },
      },
      origin,
    );
    expect(feed.homepage).toBe("https://one.example");
  });

  test("a credential in the path or query never reaches the homepage", () => {
    const keyed = withUrl("https://h.example/${api_key}/x?apikey=${api_key}", {
      credentials: { api_key: { title: "Key" } },
    });
    expect(toCatalogFeed(keyed, origin).homepage).toBe("https://h.example");
  });

  test("a credential in the host needs a written homepage, whatever its default", () => {
    const hosted = withUrl("https://${tenant}.example/x", {
      credentials: { tenant: { title: "Tenant" } },
    });
    expect(() => toCatalogFeed(hosted, origin)).toThrow(/written homepage/);

    const defaulted = withUrl("https://${tenant}.example/x", {
      credentials: { tenant: { title: "Tenant", default: "acme" } },
    });
    expect(() => toCatalogFeed(defaulted, origin)).toThrow(/written homepage/);

    const prefixed = withUrl("https://api-${tenant}.example/x", {
      credentials: { tenant: { title: "Tenant" } },
    });
    expect(() => toCatalogFeed(prefixed, origin)).toThrow(/written homepage/);
  });

  test("an expand credential in the host needs a written homepage", () => {
    const expanded: FeedDefinition = {
      ...def,
      credentials: { sub: { title: "Subscription" } },
      endpoints: { main: { url: "https://${sub}.example/x", expand: "sub", cadenceSec: 60 } },
    };
    expect(() => toCatalogFeed(expanded, origin)).toThrow(/written homepage/);
  });

  test("an account group in the host needs a written homepage", () => {
    const account = withUrl("${@acme.base}/x");
    const shared = {
      acme: { base: { title: "Base" }, token: { title: "Token", default: "t" } },
    };
    expect(() => toCatalogFeed(account, { ...origin, shared })).toThrow(/written homepage/);
    const mixed = {
      acme: { base: { title: "Base", default: "https://x.example" }, key: { title: "K" } },
    };
    expect(() => toCatalogFeed(account, { ...origin, shared: mixed })).toThrow(/written homepage/);
  });

  test("a settings group base URL needs a written homepage: a self-hosted base is no credit link", () => {
    const overpass = withUrl("${@overpass.url}/api/interpreter");
    const shared = { overpass: { url: { title: "Base", default: "https://overpass.default" } } };
    expect(() => toCatalogFeed(overpass, { ...origin, shared })).toThrow(/written homepage/);
    expect(() =>
      toCatalogFeed(overpass, { ...origin, shared: { overpass: { url: { title: "Base" } } } }),
    ).toThrow(/written homepage/);
    expect(
      toCatalogFeed({ ...overpass, homepage: "https://real.example" }, { ...origin, shared })
        .homepage,
    ).toBe("https://real.example");
  });

  test("cell placeholders do not disturb the origin", () => {
    const cells = withUrl("https://cells.example/q?lat={south}&lon={west}");
    expect(toCatalogFeed(cells, origin).homepage).toBe("https://cells.example");
  });

  test("an explicit homepage wins", () => {
    expect(toCatalogFeed({ ...def, homepage: "https://www.ndw.nu" }, origin).homepage).toBe(
      "https://www.ndw.nu",
    );
  });

  test("the written homepage must be https", () => {
    const written = z.object(feedBaseShape).strict();
    expect(written.safeParse({ ...def, homepage: "http://www.ndw.nu" }).success).toBe(false);
    expect(written.safeParse({ ...def, homepage: "https://www.ndw.nu" }).success).toBe(true);
  });
});
