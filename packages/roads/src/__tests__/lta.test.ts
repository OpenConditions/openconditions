import { describe, expect, it } from "vitest";
import { parseLtaIncidents } from "../lta.js";
import type { SourceDescriptor } from "../types.js";

const SRC: SourceDescriptor = {
  id: "lta-sg",
  attribution: "LTA Singapore",
  country: "SG",
  license: "Singapore-ODL-1.0",
};

function body(value: unknown[]): string {
  return JSON.stringify({ "odata.metadata": "x", value });
}

describe("parseLtaIncidents", () => {
  it("maps LTA incident Type to the taxonomy and builds Point geometry", () => {
    const out = parseLtaIncidents(
      body([
        {
          Type: "Accident",
          Latitude: 1.3201,
          Longitude: 103.84,
          Message: "(28/6) Accident on PIE",
        },
        { Type: "Roadwork", Latitude: 1.35, Longitude: 103.9, Message: "Roadworks on ECP" },
        {
          Type: "Vehicle breakdown",
          Latitude: 1.29,
          Longitude: 103.8,
          Message: "Breakdown on AYE",
        },
      ]),
      SRC
    );
    expect(out).toHaveLength(3);
    const byType = Object.fromEntries(out.map((e) => [e.type, e]));
    expect(byType.accident).toBeDefined();
    expect(byType.roadworks).toBeDefined();
    expect(byType.broken_down_vehicle).toBeDefined();
    expect(byType.accident!.geometry).toEqual({ type: "Point", coordinates: [103.84, 1.3201] });
    expect(byType.accident!.headline).toBe("(28/6) Accident on PIE");
    expect(byType.accident!.sourceFormat).toBe("lta-json");
  });

  it("derives a stable content-based id (LTA records carry none)", () => {
    const ev = [{ Type: "Accident", Latitude: 1.3, Longitude: 103.8, Message: "x" }];
    const a = parseLtaIncidents(body(ev), SRC);
    const b = parseLtaIncidents(body(ev), SRC);
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(a[0]!.id.startsWith("lta-sg:")).toBe(true);
  });

  it("skips records without coordinates and tolerates malformed input", () => {
    expect(parseLtaIncidents(body([{ Type: "Accident", Message: "no coords" }]), SRC)).toEqual([]);
    expect(parseLtaIncidents("not json", SRC)).toEqual([]);
    expect(parseLtaIncidents(JSON.stringify({ value: "nope" }), SRC)).toEqual([]);
  });
});
