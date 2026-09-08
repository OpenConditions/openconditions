import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIGHWAY_CLASSES,
  loadHighwayClasses,
  osmiumHighwayFilter,
  overpassHighwayRegex,
} from "../pipeline/highway-classes.js";

describe("highway classes", () => {
  it("defaults to the six major classes", () => {
    expect(loadHighwayClasses({})).toEqual(DEFAULT_HIGHWAY_CLASSES);
    expect(loadHighwayClasses({ SEGMENT_HIGHWAY_CLASSES: "" })).toEqual(DEFAULT_HIGHWAY_CLASSES);
  });
  it("parses a comma list, trims, dedupes and rejects garbage tokens", () => {
    expect(
      loadHighwayClasses({ SEGMENT_HIGHWAY_CLASSES: " motorway, secondary,secondary, bad token " })
    ).toEqual(["motorway", "secondary"]);
  });
  it("renders the Overpass regex and osmium filter", () => {
    expect(overpassHighwayRegex(["motorway", "trunk"])).toBe("^(motorway|trunk)$");
    expect(osmiumHighwayFilter(["motorway", "trunk"])).toBe("w/highway=motorway,trunk");
  });
});

// `packages/roads` cannot import from `services/ingest`, so the corpus-capture
// script repeats the class list as a literal. This guards it against drifting
// away from the default the spine import actually uses.
describe("corpus spine script", () => {
  it("captures the same classes as the import default", () => {
    const src = readFileSync(
      new URL("../../../../packages/roads/scripts/bind-corpus-spine.ts", import.meta.url),
      "utf8"
    );
    expect(src).toContain(`"${DEFAULT_HIGHWAY_CLASSES.join("|")}"`);
  });
});
