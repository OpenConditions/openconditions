import { ROADS_SOURCE_FORMATS } from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import { FEED_SOURCES, parserFor, ROAD_SOURCE_FORMATS } from "../feeds.js";
import { flowParserOf } from "../flow-parsers.js";

describe("road source formats", () => {
  it("covers every registered feed's format", () => {
    for (const feed of FEED_SOURCES) expect(ROAD_SOURCE_FORMATS).toContain(feed.format);
  });

  it("registers every parser format in the roads source_format vocabulary", () => {
    for (const format of ROAD_SOURCE_FORMATS) expect(ROADS_SOURCE_FORMATS).toContain(format);
  });

  it("resolves parsers by format and rejects unknown and inherited names", () => {
    expect(typeof parserFor("datex2")).toBe("function");
    expect(typeof flowParserOf("datex2")).toBe("function");
    expect(() => parserFor("traff")).toThrow(/No parser registered/);
    expect(() => parserFor("constructor")).toThrow(/No parser registered/);
    expect(() => flowParserOf("open511")).toThrow(/No flow parser registered/);
  });
});
