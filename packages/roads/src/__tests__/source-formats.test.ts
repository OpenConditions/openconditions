import { buildRegistry, kernelModule } from "@openconditions/model";
import { ROADS_SOURCE_FORMATS, roadsModule } from "@openconditions/model-roads";
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

  it("registers every format and reference decoder in the source_format vocabulary", () => {
    const registered = buildRegistry([kernelModule, roadsModule]).vocabulary("source_format")!;
    for (const format of Object.keys(roadsDomain.formats)) {
      expect(registered.values).toContain(format);
    }
    for (const decoder of ROAD_REFERENCE_DECODERS) expect(registered.values).toContain(decoder);
  });

  it("leaves the shared formats to the kernel", () => {
    for (const shared of ["datex2", "geojson"]) {
      expect(ROADS_SOURCE_FORMATS).not.toContain(shared);
    }
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
