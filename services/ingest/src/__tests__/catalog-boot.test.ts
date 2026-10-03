import { fileURLToPath } from "node:url";
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
    expect(cat.feeds.every((f) => f.domain === "roads")).toBe(true);
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
    expect(INGEST_DOMAINS.map((d) => d.id)).toEqual(["roads"]);
    expect(formatOf(testFeed({ format: "datex2-measured", product: "flow" })).kind).toBe(
      "measurements",
    );
    expect(formatOf(testFeed()).kind).toBe("situations");
  });

  it("throws for an unknown domain or format", () => {
    expect(() => formatOf(testFeed({ format: "no-such-format" }))).toThrow(/no-such-format/);
    expect(() => formatOf(testFeed({ domain: "weather" }))).toThrow(/weather/);
  });
});
