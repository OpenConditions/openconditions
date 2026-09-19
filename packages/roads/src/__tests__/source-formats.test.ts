import { describe, expect, it } from "vitest";
import { FEED_SOURCES, flowParserFor, parserFor, ROAD_SOURCE_FORMATS } from "../feeds.js";

describe("road source formats", () => {
  it("covers every registered feed's format", () => {
    for (const feed of FEED_SOURCES) expect(ROAD_SOURCE_FORMATS).toContain(feed.format);
  });

  it("resolves parsers by format and rejects unknown and inherited names", () => {
    expect(typeof parserFor("datex2")).toBe("function");
    expect(typeof flowParserFor("datex2")).toBe("function");
    expect(() => parserFor("traff")).toThrow(/No parser registered/);
    expect(() => parserFor("constructor")).toThrow(/No parser registered/);
    expect(() => flowParserFor("open511")).toThrow(/No flow parser registered/);
  });
});
