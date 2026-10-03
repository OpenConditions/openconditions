import { describe, expect, test } from "vitest";
import { deriveFeedId, regionOfFile } from "../catalog/ids.js";

describe("feed ids", () => {
  test("ids have region, operator and product", () => {
    expect(
      deriveFeedId({ region: "de", subdivision: "hh", operator: "autobahn", product: "flow" }),
    ).toBe("de-hh-autobahn-flow");
    expect(deriveFeedId({ region: "global", operator: "osm", product: "charging" })).toBe(
      "osm-charging",
    );
    expect(
      deriveFeedId({
        region: "ca",
        subdivision: "on",
        operator: "511",
        qualifier: "construction",
        product: "events",
      }),
    ).toBe("ca-on-511-construction-events");
  });

  test("region comes from the file name", () => {
    expect(regionOfFile("feeds/roads/de.jsonc")).toBe("de");
    expect(regionOfFile("feeds/hazards/eu.jsonc")).toBe("eu");
    expect(regionOfFile("feeds/hazards/global.jsonc")).toBe("global");
    expect(() => regionOfFile("feeds/roads/DE.jsonc")).toThrow();
    expect(() => regionOfFile("feeds/roads/europe.jsonc")).toThrow();
  });
});
