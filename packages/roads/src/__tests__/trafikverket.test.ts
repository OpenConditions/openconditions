import { describe, expect, it } from "vitest";
import { parseTrafikverket } from "../trafikverket.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "trafikverket-se",
  attribution: "Trafikverket",
  country: "SE",
  license: "CC0-1.0",
};

function body(situations: unknown[]): string {
  return JSON.stringify({ RESPONSE: { RESULT: [{ Situation: situations }] } });
}

describe("parseTrafikverket", () => {
  it("flattens Situation→Deviation, parses WKT geometry and maps MessageType", () => {
    const out = parseTrafikverket(
      body([
        {
          Deviation: [
            {
              Id: "d1",
              MessageType: "Olycka",
              Message: "Trafikolycka E4",
              SeverityCode: 4,
              RoadName: "E4",
              Geometry: { Point: { WGS84: "POINT (18.0686 59.3293)" } },
            },
            {
              Id: "d2",
              MessageType: "Vägarbete",
              Message: "Vägarbete",
              Geometry: { Line: { WGS84: "LINESTRING (17.0 59.0, 17.1 59.1)" } },
            },
          ],
        },
      ]),
      SRC
    );
    expect(out).toHaveLength(2);
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(byId["trafikverket-se:d1"]!.type).toBe("accident");
    expect(byId["trafikverket-se:d1"]!.severity).toBe("high");
    expect(byId["trafikverket-se:d1"]!.geometry).toEqual({
      type: "Point",
      coordinates: [18.0686, 59.3293],
    });
    expect(byId["trafikverket-se:d2"]!.type).toBe("roadworks");
    expect(byId["trafikverket-se:d2"]!.geometry!.type).toBe("LineString");
    expect(out[0]!.sourceFormat).toBe("trafikverket-json");
  });

  it("skips deviations without geometry and tolerates malformed input", () => {
    expect(
      parseTrafikverket(body([{ Deviation: [{ Id: "x", MessageType: "Olycka" }] }]), SRC)
    ).toEqual([]);
    expect(parseTrafikverket("not json", SRC)).toEqual([]);
    expect(parseTrafikverket(JSON.stringify({ RESPONSE: {} }), SRC)).toEqual([]);
  });
});
