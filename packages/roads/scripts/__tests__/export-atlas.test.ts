import { describe, expect, it } from "vitest";
import type { FeedSourceBase } from "@openconditions/ingest-framework";
import { buildAtlas } from "../export-atlas.js";

// a curated feed carrying a function-valued url (defensive: pre-L6 closure shape)
const withClosure = {
  id: "mobilithek-x",
  name: "X",
  format: "datex2",
  url: (env: Record<string, string | undefined>) => `https://x/${env["ID"] ?? ""}`,
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "dl-de/by-2-0",
  attribution: "X",
  country: "DE",
  privacyUrl: "https://x",
} as unknown as FeedSourceBase;

const staticFeed: FeedSourceBase = {
  id: "nl-ndw",
  name: "NDW",
  format: "datex2",
  url: "https://opendata.ndw.nu/actueel_beeld.xml.gz",
  cadenceSec: 60,
  freshnessWindowSec: 300,
  license: "CC0-1.0",
  attribution: "NDW",
  country: "NL",
  privacyUrl: "https://x",
};

const resolvedWzdx: FeedSourceBase = {
  id: "wzdx-alpha",
  name: "WZDx — Alpha (alpha)",
  format: "wzdx",
  url: "https://alpha.example/api/wzdx",
  cadenceSec: 300,
  freshnessWindowSec: 900,
  license: "CC0-1.0",
  attribution: "Alpha DOT",
  country: "US",
  privacyUrl: "https://x",
};

describe("buildAtlas", () => {
  it("drops function-valued fields, keeps static + resolved feeds, dedupes by id", () => {
    const atlas = buildAtlas([staticFeed, withClosure], [[resolvedWzdx]]);
    const ids = atlas.map((f) => f.id).sort();
    expect(ids).toEqual(["mobilithek-x", "nl-ndw", "wzdx-alpha"].sort());
    const x = atlas.find((f) => f.id === "mobilithek-x");
    expect(typeof x?.url).not.toBe("function"); // closure dropped → undefined
    // no descriptor holds any function-valued field
    for (const f of atlas) {
      for (const v of Object.values(f)) expect(typeof v).not.toBe("function");
    }
    expect(JSON.stringify(atlas)).toContain("wzdx-alpha"); // fully serialisable
  });

  it("prefers the curated feed over a resolved feed on id collision", () => {
    const dupResolved = { ...resolvedWzdx, id: "nl-ndw", attribution: "resolved" };
    const atlas = buildAtlas([staticFeed], [[dupResolved]]);
    expect(atlas.filter((f) => f.id === "nl-ndw")).toHaveLength(1);
    expect(atlas.find((f) => f.id === "nl-ndw")?.attribution).toBe("NDW");
  });
});
