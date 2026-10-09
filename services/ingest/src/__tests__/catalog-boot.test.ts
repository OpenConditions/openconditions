import { fileURLToPath } from "node:url";
import { resolveEndpointUrls } from "@openconditions/ingest-framework";
import { describe, expect, it } from "vitest";
import { formatOf, INGEST_DOMAINS, loadIngestCatalog } from "../domains.js";
import { testFeed } from "./helpers/catalog.js";

const DISABLED_MOUNT = fileURLToPath(new URL("./fixtures/catalog-disabled", import.meta.url));

describe("loadIngestCatalog", () => {
  it("boot loads the repo catalogue", async () => {
    const cat = await loadIngestCatalog({});
    expect(cat.feeds.length + cat.discovered.length + cat.disabled.length).toBeGreaterThanOrEqual(
      86,
    );
    expect(new Set(cat.feeds.map((f) => f.domain))).toEqual(
      new Set(["roads", "fuel", "parking", "charging", "cameras", "hazards"]),
    );
    expect(cat.feeds.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        "es-minetur-fuel",
        "fr-prixcarburants-fuel",
        "de-bw-mobidata-parking",
        "osm-parking",
        "fi-digitraffic-cameras",
        "osm-cameras",
        "us-nws-alerts",
        "nasa-firms-viirs-fires",
      ]),
    );
    expect(cat.disabled.map((f) => f.id)).toEqual(
      expect.arrayContaining(["de-ni-braunschweig-parking", "de-bb-potsdam-parking"]),
    );
  });

  it("osm-fuel posts to the Overpass base URL plus /api/interpreter", async () => {
    const cat = await loadIngestCatalog({});
    const osm = cat.feeds.find((f) => f.id === "osm-fuel")!;
    expect(resolveEndpointUrls(osm, "main", {})).toEqual([
      "https://overpass-api.de/api/interpreter",
    ]);
    expect(resolveEndpointUrls(osm, "main", { OVERPASS_URL: "http://overpass:80" })).toEqual([
      "http://overpass:80/api/interpreter",
    ]);
    // A base URL written with a trailing slash queries the same interpreter.
    expect(resolveEndpointUrls(osm, "main", { OVERPASS_URL: "http://overpass:80/" })).toEqual([
      "http://overpass:80/api/interpreter",
    ]);
    // So does the full interpreter URL, OpenMapX's other OVERPASS_URL form.
    expect(
      resolveEndpointUrls(osm, "main", { OVERPASS_URL: "http://overpass:80/api/interpreter" }),
    ).toEqual(["http://overpass:80/api/interpreter"]);
  });

  it("layers an operator's mount over the baked catalogue", async () => {
    const cat = await loadIngestCatalog({ OPENCONDITIONS_FEEDS_DIR: DISABLED_MOUNT });
    const disabled = cat.disabled.find((f) => f.id === "lu-fixture-events");
    expect(disabled?.disabled?.reason).toBe("fixture: upstream retired the endpoint");
    expect(cat.feeds.some((f) => f.id === "lu-fixture-events")).toBe(false);
    expect(cat.feeds.some((f) => f.id === "nl-ndw-events")).toBe(true);
  });
});

describe("formatOf", () => {
  it("finds a feed's format in its domain", () => {
    expect(INGEST_DOMAINS.map((d) => d.id)).toEqual([
      "roads",
      "fuel",
      "parking",
      "charging",
      "cameras",
      "hazards",
    ]);
    expect(formatOf(testFeed({ format: "datex2-measured", product: "flow" })).kind).toBe(
      "measurements",
    );
    expect(formatOf(testFeed()).kind).toBe("situations");
    expect(formatOf(testFeed({ domain: "fuel", format: "minetur", product: "fuel" })).kind).toBe(
      "features",
    );
    expect(
      formatOf(testFeed({ domain: "parking", format: "geojson", product: "parking" })).kind,
    ).toBe("features");
    expect(
      formatOf(testFeed({ domain: "cameras", format: "overpass", product: "cameras" })).kind,
    ).toBe("features");
    expect(formatOf(testFeed({ domain: "hazards", format: "cap", product: "alerts" })).kind).toBe(
      "situations",
    );
  });

  it("throws for an unknown domain or format", () => {
    expect(() => formatOf(testFeed({ format: "no-such-format" }))).toThrow(/no-such-format/);
    expect(() => formatOf(testFeed({ domain: "weather" }))).toThrow(/weather/);
  });
});
