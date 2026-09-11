import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadFeeds,
  materializeApprovedCatalogChildren,
  registerFeedSchema,
} from "@openconditions/ingest-framework";
import {
  FEED_SOURCES,
  autobahnIndexResolver,
  roadFeedSchema,
  wzdxRegistryResolver,
} from "@openconditions/roads";
import { buildAtlas } from "../export-atlas.js";

const staticFeed = roadFeedSchema.parse({
  operator: "ndw",
  name: "NDW",
  format: "datex2",
  url: "https://opendata.ndw.nu/actueel_beeld.xml.gz",
  cadenceSec: 60,
  freshnessWindowSec: 300,
  license: "CC0-1.0",
  attribution: "NDW",
  country: "NL",
  privacyUrl: "https://www.ndw.nu",
});

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const jsonResponder =
  (payload: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(payload));

const serialized = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("buildAtlas", () => {
  it("preserves resolved fixture identities, URLs and grants through the real schema", async () => {
    const autobahn = await autobahnIndexResolver.resolve(
      jsonResponder(
        JSON.parse(
          readFileSync(
            new URL("../../src/__tests__/fixtures/autobahn/road-index.json", import.meta.url),
            "utf8"
          )
        )
      )
    );
    const wzdx = await wzdxRegistryResolver.resolve(
      jsonResponder(
        JSON.parse(
          readFileSync(
            new URL("../../src/__tests__/fixtures/wzdx/registry.json", import.meta.url),
            "utf8"
          )
        )
      )
    );
    const atlas = buildAtlas([staticFeed], [autobahn, wzdx]);
    const reloaded = serialized(atlas).map((feed) => roadFeedSchema.parse(feed));
    expect(reloaded).toEqual(serialized([staticFeed, ...autobahn, ...wzdx]));
    expect(new Set(reloaded.map((feed) => feed.id)).size).toBe(1 + autobahn.length + wzdx.length);
  });

  it("rejects duplicate identities within an export layer while allowing curated overrides", () => {
    expect(() => buildAtlas([staticFeed, staticFeed], [])).toThrow(/duplicate atlas feed id/);
    expect(() => buildAtlas([], [[staticFeed, staticFeed]])).toThrow(/duplicate atlas feed id/);
    expect(buildAtlas([staticFeed], [[{ ...staticFeed, attribution: "resolved" }]])).toEqual([
      staticFeed,
    ]);
  });

  it("rejects serialized identity drift instead of silently renaming the export", () => {
    expect(() => buildAtlas([{ ...staticFeed, id: "old-ndw" }], [])).toThrow(
      /does not match derived id/
    );
  });

  it("loads the complete vendored atlas without collapsing identities or scheduling discoveries", async () => {
    const atlas = buildAtlas(FEED_SOURCES, [
      autobahnIndexResolver.snapshot!,
      wzdxRegistryResolver.snapshot!,
    ]);
    const dir = mkdtempSync(join(tmpdir(), "oc-atlas-contract-"));
    temporaryDirs.push(dir);
    writeFileSync(join(dir, "baked.json5"), JSON.stringify(FEED_SOURCES));
    registerFeedSchema("roads", roadFeedSchema);
    const loaded = await loadFeeds(
      {
        domain: "roads",
        bakedInDir: dir,
        remote: {
          enabled: true,
          url: "https://atlas.example.test/roads.json5",
          snapshotPath: join(dir, "remote.json"),
        },
      },
      { remoteFetch: jsonResponder(atlas), assertUrl: () => {} }
    );
    expect(serialized(loaded)).toEqual(serialized(atlas));
    expect(loaded).toHaveLength(
      FEED_SOURCES.length +
        autobahnIndexResolver.snapshot!.length +
        wzdxRegistryResolver.snapshot!.length
    );
    expect(new Set(loaded.map((feed) => feed.id)).size).toBe(loaded.length);
    const result = materializeApprovedCatalogChildren(loaded);
    const children = result.scheduled.filter((feed) => feed.parentSourceId === "us-wzdx");
    expect(children.map((feed) => feed.id)).toEqual(["us-wzdx-fe9b3423ea03546f"]);
    expect(children[0]).toMatchObject({
      url: "https://ks.carsprogram.org/carsapi_v1/api/wzdx",
      license: "CC0-1.0",
      selectionState: "approved",
      parentSourceId: "us-wzdx",
      policyIds: ["us-wzdx", "us-wzdx-fe9b3423ea03546f"],
      rights: {
        sourceRedistribution: true,
        derivedRedistribution: true,
        commercialUse: true,
        retention: true,
      },
    });
    expect(result.scheduled.some((feed) => feed.parentSourceId === "de-autobahn")).toBe(false);
    expect(result.scheduled.filter((feed) => feed.id === "de-autobahn")).toHaveLength(1);
    const discoveries = result.discovered.filter((feed) => feed.parentSourceId === "us-wzdx");
    expect(discoveries).toHaveLength(wzdxRegistryResolver.snapshot!.length - 1);
    expect(
      discoveries.every(
        (feed) => feed.license === "UNKNOWN" && feed.selectionState === "discovered"
      )
    ).toBe(true);
  });
});
