import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { feedToSourceDescriptor } from "../feeds.js";
import { parseTrafikverket } from "../trafikverket.js";
import type { SourceDescriptor } from "../types.js";
import { testFeed } from "./helpers/test-feeds.js";

const SRC: SourceDescriptor = {
  id: "se-trafikverket-situations-events",
  attribution: "Trafikverket",
  country: "SE",
  license: "CC0-1.0",
};

function body(situations: unknown[]): string {
  return JSON.stringify({ RESPONSE: { RESULT: [{ Situation: situations }] } });
}

const at = (wkt: string) => ({ Point: { WGS84: wkt } });

function one(deviation: Record<string, unknown>, situation: Record<string, unknown> = {}) {
  const out = parseTrafikverket(
    body([{ Id: "s", ...situation, Deviation: [{ Id: "d", ...deviation }] }]),
    SRC,
  );
  expect(out).toHaveLength(1);
  return out[0]!;
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
              Geometry: at("POINT (18.0686 59.3293)"),
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
      SRC,
    );
    expect(out).toHaveLength(2);
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    const d1 = byId["se-trafikverket-situations-events:d1"]!;
    expect(d1.type).toBe("accident");
    expect(d1.severity).toBe("high");
    expect(d1.geometry).toEqual({ type: "Point", coordinates: [18.0686, 59.3293] });
    const d2 = byId["se-trafikverket-situations-events:d2"]!;
    expect(d2.type).toBe("roadworks");
    expect(d2.geometry!.type).toBe("LineString");
    expect(out[0]!.sourceFormat).toBe("trafikverket");
  });

  it("skips deviations without geometry and tolerates malformed input", () => {
    expect(
      parseTrafikverket(body([{ Deviation: [{ Id: "x", MessageType: "Olycka" }] }]), SRC),
    ).toEqual([]);
    expect(parseTrafikverket("not json", SRC)).toEqual([]);
    expect(parseTrafikverket(JSON.stringify({ RESPONSE: {} }), SRC)).toEqual([]);
  });

  describe("geometry", () => {
    it("keeps every part of a MULTILINESTRING", () => {
      const ev = one({
        MessageType: "Färjor",
        Geometry: {
          Line: {
            WGS84: "MULTILINESTRING ((11.72 57.68, 11.71 57.68), (11.71 57.68, 11.70 57.68))",
          },
        },
      });
      expect(ev.geometry).toEqual({
        type: "MultiLineString",
        coordinates: [
          [
            [11.72, 57.68],
            [11.71, 57.68],
          ],
          [
            [11.71, 57.68],
            [11.7, 57.68],
          ],
        ],
      });
    });

    it("reads a one-part MULTILINESTRING as a LineString", () => {
      const ev = one({
        MessageType: "Hinder",
        Geometry: { Line: { WGS84: "MULTILINESTRING((17 59,17.1 59.1))" } },
      });
      expect(ev.geometry).toEqual({
        type: "LineString",
        coordinates: [
          [17, 59],
          [17.1, 59.1],
        ],
      });
    });

    it("drops the Z of a 3D point or line", () => {
      expect(
        one({ MessageType: "Hinder", Geometry: at("POINT Z (13.41 55.88 0)") }).geometry,
      ).toEqual({ type: "Point", coordinates: [13.41, 55.88] });
      expect(
        one({
          MessageType: "Hinder",
          Geometry: { Line: { WGS84: "LINESTRING Z (17 59 1, 17.1 59.1 2)" } },
        }).geometry,
      ).toEqual({
        type: "LineString",
        coordinates: [
          [17, 59],
          [17.1, 59.1],
        ],
      });
    });

    it("reads a POLYGON and the deviation-level Geometry.WGS84", () => {
      const ev = one({
        MessageType: "Viktig trafikinformation",
        Geometry: { WGS84: "POLYGON ((17 59, 17.1 59, 17.1 59.1, 17 59))" },
      });
      expect(ev.geometry).toEqual({
        type: "Polygon",
        coordinates: [
          [
            [17, 59],
            [17.1, 59],
            [17.1, 59.1],
            [17, 59],
          ],
        ],
      });
    });

    it("prefers the line over the point and rejects malformed WKT", () => {
      const ev = one({
        MessageType: "Hinder",
        Geometry: {
          Point: { WGS84: "POINT (17.05 59.05)" },
          Line: { WGS84: "LINESTRING (17 59, 17.1 59.1)" },
        },
      });
      expect(ev.geometry!.type).toBe("LineString");
      expect(
        parseTrafikverket(
          body([{ Id: "s", Deviation: [{ Id: "d", Geometry: at("POINT (17 59") }] }]),
          SRC,
        ),
      ).toEqual([]);
    });
  });

  describe("MessageType", () => {
    it("maps the documented values", () => {
      expect(one({ MessageType: "Färjor", Geometry: at("POINT (17 59)") }).type).toBe(
        "transit_disruption",
      );
      expect(one({ MessageType: "Hinder", Geometry: at("POINT (17 59)") }).type).toBe(
        "obstruction",
      );
      expect(one({ MessageType: "Trafikmeddelande", Geometry: at("POINT (17 59)") }).type).toBe(
        "other",
      );
      expect(
        one({ MessageType: "Viktig trafikinformation", Geometry: at("POINT (17 59)") }).type,
      ).toBe("other");
    });

    it("reads a Restriktion's kind from its TemporaryLimit", () => {
      const weight = one({
        MessageType: "Restriktion",
        TemporaryLimit: "bruttovikt 8 ton",
        Geometry: at("POINT (17 59)"),
      });
      expect(weight.type).toBe("dimension_restriction");
      const speed = one({
        MessageType: "Restriktion",
        TemporaryLimit: "hastighet 50 km/h",
        Geometry: at("POINT (17 59)"),
      });
      expect(speed.type).toBe("speed_restriction");
      expect(one({ MessageType: "Restriktion", Geometry: at("POINT (17 59)") }).type).toBe("other");
    });

    it("drops the feed's excluded MessageTypes and keeps the rest of the situation", () => {
      const out = parseTrafikverket(
        body([
          {
            Id: "s",
            Deviation: [
              { Id: "accident", MessageType: "Olycka", Geometry: at("POINT (17 59)") },
              { Id: "obstacle", MessageType: "Hinder", Geometry: at("POINT (17.01 59.01)") },
              { Id: "works", MessageType: "vägarbete", Geometry: at("POINT (17.02 59.02)") },
            ],
          },
        ]),
        { ...SRC, excludeMessageTypes: ["Olycka", "Vägarbete"] },
      );
      expect(out.map((e) => e.id)).toEqual(["se-trafikverket-situations-events:obstacle"]);
      expect(out[0]!.situationId).toBe("s");
    });
  });

  describe("times and lifecycle", () => {
    it("takes the update time from VersionTime, never the StartTime", () => {
      const ev = one(
        {
          MessageType: "Hinder",
          StartTime: "2026-10-01T08:00:00.000+02:00",
          VersionTime: "2026-10-14T07:55:10.000+02:00",
          Geometry: at("POINT (17 59)"),
        },
        { ModifiedTime: "2026-10-14T05:55:11.004Z" },
      );
      expect(ev.dataUpdatedAt).toBe("2026-10-14T05:55:10.000Z");
      expect(ev.situation?.sourceUpdatedAt).toBe("2026-10-14T05:55:10.000Z");
      expect(ev.validFrom).toBe("2026-10-01T06:00:00.000Z");
    });

    it("falls back to the situation's VersionTime, then its ModifiedTime", () => {
      const fromVersion = one(
        { MessageType: "Hinder", StartTime: "2026-10-01T08:00:00Z", Geometry: at("POINT (17 59)") },
        { VersionTime: "2026-10-14T09:00:00.000+02:00", ModifiedTime: "2026-10-14T07:00:01.000Z" },
      );
      expect(fromVersion.dataUpdatedAt).toBe("2026-10-14T07:00:00.000Z");
      const fromModified = one(
        { MessageType: "Hinder", StartTime: "2026-10-01T08:00:00Z", Geometry: at("POINT (17 59)") },
        { ModifiedTime: "2026-10-14T07:00:01.000Z" },
      );
      expect(fromModified.dataUpdatedAt).toBe("2026-10-14T07:00:01.000Z");
    });

    it("reads a time without an offset in the feed's zone", () => {
      const out = parseTrafikverket(
        body([
          {
            Id: "s",
            Deviation: [
              {
                Id: "d",
                MessageType: "Restriktion",
                StartTime: "2026-03-20T00:00:00",
                EndTime: "2026-07-01T12:00:00",
                Geometry: at("POINT (17 59)"),
              },
            ],
          },
        ]),
        { ...SRC, timeZone: "Europe/Stockholm" },
      );
      expect(out[0]!.validFrom).toBe("2026-03-19T23:00:00.000Z");
      expect(out[0]!.validTo).toBe("2026-07-01T10:00:00.000Z");
    });

    it("skips a deleted situation", () => {
      expect(
        parseTrafikverket(
          body([
            {
              Id: "s",
              Deleted: true,
              Deviation: [{ Id: "d", MessageType: "Hinder", Geometry: at("POINT (17 59)") }],
            },
          ]),
          SRC,
        ),
      ).toEqual([]);
    });

    it("keeps a suspended deviation as inactive", () => {
      const ev = one({
        MessageType: "Restriktion",
        Suspended: true,
        Geometry: at("POINT (17 59)"),
      });
      expect(ev.status).toBe("inactive");
      expect(ev.situation?.validityStatus).toBe("suspended");
      expect(one({ MessageType: "Hinder", Geometry: at("POINT (17 59)") }).status).toBe("active");
    });
  });

  it("reads the documented-schema fixture through the feed's descriptor", () => {
    const input = readFileSync(join(import.meta.dirname, "fixtures/trafikverket/situations.json"));
    const out = parseTrafikverket(
      input,
      feedToSourceDescriptor(testFeed("se-trafikverket-situations-events")),
    );
    const byId = Object.fromEntries(
      out.map((e) => [e.id.replace("se-trafikverket-situations-events:SE_STA_TRISSID_1_", ""), e]),
    );
    expect(Object.keys(byId).sort()).toEqual([
      "9000001_D1",
      "9000002_D2",
      "9000003_D1",
      "9000004_D1",
    ]);
    const ferry = byId["9000001_D1"]!;
    expect(ferry.type).toBe("transit_disruption");
    expect(ferry.geometry!.type).toBe("MultiLineString");
    expect(ferry.direction).toBe("both");
    expect(ferry.headline).toBe("Färjeleden Hönöleden");
    const restriction = byId["9000003_D1"]!;
    expect(restriction.type).toBe("dimension_restriction");
    expect(restriction.status).toBe("inactive");
    expect(restriction.dataUpdatedAt).toBe("2026-10-01T08:00:00.000Z");
    expect(restriction.roads).toEqual([{ name: "Väg 331", ref: "Väg 331" }]);
  });
});

describe("WKT dimension whitespace", () => {
  it.each([
    "point(18 59)",
    "POINTZ(18 59 3)",
    "PointM(18 59 4)",
    "POINT ZM (18 59 3 4)",
    " \nPOINT\u00a0ZM\n(18 59 3 4) \t",
  ])("preserves supported %j", (wkt) => {
    expect(one({ Geometry: at(wkt) }).geometry).toEqual({ type: "Point", coordinates: [18, 59] });
  });

  it.each([
    "POINT Z M (18 59 3 4)",
    "POINT ZZ (18 59)",
    "POINT EMPTY",
    "POINT (18)",
    "POINT (18 59) trailing",
  ])("preserves fallback for %j", (wkt) => {
    const ev = one({ Geometry: { Line: { WGS84: wkt }, Point: { WGS84: "POINT (17 58)" } } });
    expect(ev.geometry).toEqual({ type: "Point", coordinates: [17, 58] });
    expect(
      parseTrafikverket(body([{ Id: "s", Deviation: [{ Id: "d", Geometry: at(wkt) }] }]), SRC),
    ).toEqual([]);
  });

  it("bounds malformed WKT whitespace before valid geometry fallback", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      const { parseTrafikverket } = await import(process.argv[1]);
      const src = JSON.parse(process.argv[2]);
      const read = (wkt) => parseTrafikverket(JSON.stringify({ RESPONSE: { RESULT: [{ Situation: [{ Id: "s", Deviation: [{ Id: "d", Geometry: { Line: { WGS84: wkt }, Point: { WGS84: "POINT (17 58)" } } }] }] }] } }), src);
      assert.deepEqual(read("POINT ZM (18 59 1 2)")[0].geometry, { type: "Point", coordinates: [18, 59] });
      console.log("control passed");
      const out = read("POINT" + " ".repeat(100_000) + "!");
      assert.equal(out.length, 1);
      assert.deepEqual(out[0].geometry, { type: "Point", coordinates: [17, 58] });
      console.log("decoded");
    `,
        new URL("../../dist/index.js", import.meta.url).href,
        JSON.stringify(SRC),
      ],
      { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
    );
    expect(result.stdout).toContain("control passed");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("control passed\ndecoded");
  });
});
