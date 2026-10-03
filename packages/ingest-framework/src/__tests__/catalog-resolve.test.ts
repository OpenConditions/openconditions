import { describe, expect, test } from "vitest";
import { toCatalogFeed } from "../catalog/resolve.js";
import type { FeedDefinition } from "../catalog/types.js";

const def: FeedDefinition = {
  subdivision: "hh",
  operator: "autobahn",
  product: "flow",
  name: "Autobahn NL Nord",
  format: "datex2-measured",
  tier: "authoritative",
  endpoints: {
    main: { url: "https://a", cadenceSec: 120 },
    fast: { url: "https://b", cadenceSec: 60 },
    sites: { url: "https://s", decoder: "datex2-sites", cadenceSec: 30 },
  },
  freshnessWindowSec: 600,
  license: "DL-DE-BY-2.0",
  attribution: "Autobahn GmbH",
  privacyUrl: "https://p",
};

const ctx = {
  domain: "roads",
  region: "de",
  file: "feeds/roads/de.jsonc",
  maintainers: [{ name: "M", github: "m" }],
};

describe("toCatalogFeed", () => {
  test("derives id, country, rights, coverage and cadence", () => {
    const feed = toCatalogFeed(def, ctx);
    expect(feed).toMatchObject({
      ...def,
      id: "de-hh-autobahn-flow",
      domain: "roads",
      region: "de",
      country: "DE",
      file: "feeds/roads/de.jsonc",
      maintainers: [{ name: "M", github: "m" }],
      coverage: { countries: ["DE"] },
      cadenceSec: 60,
    });
    expect(feed.rights.redistribution).toBe(true);
  });

  test("terms override the licence", () => {
    const feed = toCatalogFeed({ ...def, terms: { note: "n", commercialUse: false } }, ctx);
    expect(feed.rights.commercialUse).toBe(false);
  });

  test("a written coverage wins; eu and global have no country", () => {
    const eu = toCatalogFeed(
      { ...def, coverage: { bbox: [0, 1, 2, 3] } },
      { ...ctx, region: "eu" },
    );
    expect(eu.country).toBeUndefined();
    expect("country" in eu).toBe(false);
    expect(eu.coverage).toEqual({ bbox: [0, 1, 2, 3] });
    expect(eu.id).toBe("eu-hh-autobahn-flow");

    const global = toCatalogFeed(def, { ...ctx, region: "global" });
    expect(global.id).toBe("hh-autobahn-flow");
    expect(global.coverage).toEqual({});
  });

  test("a feed needs an endpoint that is not reference data", () => {
    expect(() =>
      toCatalogFeed(
        { ...def, endpoints: { sites: { url: "https://s", decoder: "d", cadenceSec: 60 } } },
        ctx,
      ),
    ).toThrow(/no data endpoint/);
  });

  test("an unknown licence throws", () => {
    expect(() => toCatalogFeed({ ...def, license: "Nope" }, ctx)).toThrow(/Nope/);
  });
});
