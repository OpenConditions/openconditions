import { ROADS_SOURCE_FORMATS } from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import { ROAD_REFERENCE_DECODERS, roadsDomain } from "../domain.js";
import { FLOW_FORMAT_CODES, flowParserOf } from "../flow-parsers.js";
import { SITUATION_FORMAT_CODES, situationParserOf } from "../parse.js";

describe("road source formats", () => {
  it("declares a format for every parser", () => {
    expect(Object.keys(roadsDomain.formats).sort()).toEqual(
      [...SITUATION_FORMAT_CODES, ...FLOW_FORMAT_CODES].sort(),
    );
  });

  it("registers every format and reference decoder in the roads source_format vocabulary", () => {
    for (const format of Object.keys(roadsDomain.formats)) {
      expect(ROADS_SOURCE_FORMATS).toContain(format);
    }
    for (const decoder of ROAD_REFERENCE_DECODERS) expect(ROADS_SOURCE_FORMATS).toContain(decoder);
  });

  it("resolves parsers by format and rejects unknown and inherited names", () => {
    expect(typeof situationParserOf("datex2")).toBe("function");
    expect(typeof flowParserOf("datex2-measured")).toBe("function");
    expect(() => flowParserOf("datex2")).toThrow(/No flow parser registered/);
    expect(() => situationParserOf("traff")).toThrow(/No situation parser registered/);
    expect(() => situationParserOf("constructor")).toThrow(/No situation parser registered/);
    expect(() => flowParserOf("open511")).toThrow(/No flow parser registered/);
  });
});
