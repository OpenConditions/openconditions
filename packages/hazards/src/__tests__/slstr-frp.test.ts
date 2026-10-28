import { spawnSync } from "node:child_process";
import {
  __resetSkips,
  drainSkipped,
  type FeedPayloads,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import { catalogFeed, fixture, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-16T21:00:00Z";
const slstr = hazardsDomain.formats["slstr-frp"]!;
const feed = catalogFeed("eumetsat-slstr-fires");
const parse = (...granules: (Buffer | string)[]): ParseOutput =>
  slstr.parse(
    feed,
    {
      granules: [Buffer.from('{"type":"FeatureCollection","features":[]}')],
      fires: granules.map((b) => Buffer.from(b)),
    } satisfies FeedPayloads,
    parseContext(FETCHED, 900),
  );

const byLocation = (out: ParseOutput, lat: number, lon: number) =>
  out.observations.find((o) => {
    const [x, y] = (o["location"] as { geometry: { coordinates: number[] } }).geometry
      .coordinates as [number, number];
    return x === lon && y === lat;
  }) as RecordDraft;

/** The product's column header row. */
const HEADER =
  "lat(deg),lon(deg),day,time,D/N,FRP(MW),FRPerr(MW),used_channel,confidence(%),confidence_class(lower=0;nominal=1;higher=2),MWIR_BT(K),IFOV_area(m2),SZA(deg),VZA(deg),actrack(km),altrack(km),satellite";
const META =
  "#title = SLSTR Level 2 Product, Fire Radiative Power (FRP) measurement, Near Real Time (NRT)\n#number_of_detected_fires = 1\n\n";
const granule = (...rows: string[]) => `${META}${HEADER}\n${rows.join("\n")}\n`;

describe("the slstr-frp format over the captures", () => {
  const out = parse(
    fixture("slstr-frp-s3b-night.csv"),
    fixture("slstr-frp-s3a-day.csv"),
    fixture("slstr-frp-no-fires.csv"),
  );

  test("every fire of every granule is a fire.frp reading that seals", () => {
    expect(out.observations).toHaveLength(14);
    expect(out.situations).toEqual([]);
    expect(out.rejected).toBeUndefined();
    expect(sealFailures(out.observations)).toEqual([]);
  });

  test("a Sentinel-3B night pixel carries its power and its uncertainty, class, percentage, pixel size and baseline", () => {
    const o = byLocation(out, 24.03023, 40.476057);
    expect(o).toMatchObject({
      class: "observation",
      kind: "observation",
      property: "fire.frp",
      temporality: "live",
      subject: { kind: "location" },
      result: { type: "quantity", value: 8.16383, unit: "MW", accuracy: 0.838197 },
      phenomenonTime: { instant: "2026-10-16T19:11:26Z" },
      aggregation: "instantaneous",
      quality: { supplierCode: "high", confidence: 0.914 },
      location: {
        geometry: { type: "Point", coordinates: [40.476057, 24.03023] },
        extent: "point",
        fuzziness: "low_res",
      },
      extras: {
        instrument: "slstr",
        satellite: "S3B",
        brightnessK: 309.13,
        daynight: "night",
        scan: 1.1,
        track: 1.14,
        channel: "S7",
        version: "FRP_NRT.003.02.00",
      },
      provenance: {
        sourceId: "eumetsat-slstr-fires",
        sourceFormat: "slstr-frp",
        accessMode: "bulk",
        recordId: "S3B:24.030230,40.476057:2026-10-16T19:11:26",
      },
    });
    expect(String(o["id"])).toMatch(/^oc:observation:eumetsat-slstr-fires:[0-9a-f]{64}$/);
  });

  test("the class decides, whatever the percentage: a daytime gas flare is low at 97.5%", () => {
    expect(byLocation(out, 32.250556, 47.243745)).toMatchObject({
      quality: { supplierCode: "low", confidence: 0.975 },
      extras: { satellite: "S3A", daynight: "day", channel: "F1" },
    });
    expect(byLocation(out, 36.256972, 51.181085)["quality"]).toEqual({
      supplierCode: "nominal",
      confidence: 0.783,
    });
    expect(byLocation(out, 31.088999, 47.785115)["quality"]).toEqual({
      supplierCode: "low",
      confidence: 0,
    });
  });

  test("a detection stays current for 72 hours after the satellite saw it", () => {
    expect(byLocation(out, 31.033373, 47.283539)["freshness"]).toEqual({
      fetchedAt: FETCHED,
      expiresAt: "2026-10-19T06:57:31Z",
    });
  });

  test("a granule without fires adds nothing", () => {
    const empty = parse(fixture("slstr-frp-no-fires.csv"));
    expect(empty.observations).toEqual([]);
    expect(empty.rejected).toBeUndefined();
  });

  test("the same pixel in two polls, or twice in one, has the same id and is read once", () => {
    const again = parse(fixture("slstr-frp-s3b-night.csv"), fixture("slstr-frp-s3b-night.csv"));
    expect(again.observations.map((o) => o["id"])).toEqual(
      out.observations.slice(0, 9).map((o) => o["id"]),
    );
  });
});

describe("a row or granule that does not read", () => {
  const good = "10,20,2026-10-16,03:05:00,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A";
  const rows = [
    good,
    "NaN,20,2026-10-16,03:05:00,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
    "95,20,2026-10-16,03:05:00,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
    "10,181,2026-10-16,03:05:00,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
    "10,20,2026-02-30,03:05:00,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
    "10,20,2026-10-16,24:00:00,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
    "10,20,2026-10-16,0305,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
    "10,20,2026-10-16,03:05:00,D,-0.1,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
    "10,20,2026-10-16,03:05:00,D,,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,",
    "11,21,2026-10-16,03:05:00,N,0,,S7,,7,,,,,,,S3B",
    ",,2026-10-16,03:05:00,D,2.5,0.4,F1,90.0,2,320,1200000,40,10,1.1,1.1,S3A",
  ];
  const out = parse(granule(...rows));

  test("is skipped under its reason while the rest of the granule is kept", () => {
    __resetSkips();
    const again = parse(granule(...rows));
    // The bare pixel's class 7 is none the product defines.
    expect(drainSkipped(feed.id)).toEqual({ malformed: 8, no_geometry: 1, unknown_value: 1 });
    expect(again.rejected).toBeUndefined();
    expect(out.observations).toHaveLength(2);
    expect(sealFailures(out.observations)).toEqual([]);
  });

  test("a pixel without a class or percentage has no quality, and no extra it lacks", () => {
    const bare = byLocation(out, 11, 21);
    expect(bare["quality"]).toBeUndefined();
    expect(bare["extras"]).toEqual({
      instrument: "slstr",
      satellite: "S3B",
      daynight: "night",
      channel: "S7",
    });
  });

  test("a granule that is no FRP file is skipped as malformed, unless no granule is one", () => {
    const html = "<!DOCTYPE html><html><body>Maintenance</body></html>";
    __resetSkips();
    const mixed = parse(html, granule(good));
    expect(mixed.observations).toHaveLength(1);
    expect(mixed.rejected).toBeUndefined();
    expect(drainSkipped(feed.id)).toEqual({ malformed: 1 });
    expect(() => parse(html, '{"error":"busy"}')).toThrow(
      "none of the 2 granules is an SLSTR FRP file",
    );
  });

  test("a poll with no granule listed parses to nothing", () => {
    expect(parse().observations).toEqual([]);
  });
});

describe("column legend grammar", () => {
  const csv = (latitude: string) =>
    `${latitude},lon,day,time,FRP,satellite\n10,20,2026-10-16,03:05:00,2.5,S3A\n`;

  test.each([
    ["lat", true],
    [" lat(deg) ", true],
    ["lat(first)(second)", true],
    ["lat((nested))", true],
    ["lat()()", true],
    ["lat(unclosed", false],
    ["lat(x)tail", false],
    ["lat(inside\rbreak)", false],
    ["lat(inside\nbreak)", false],
    ["lat(inside\r\nbreak)", false],
    ["lat(a\u000bb)", true],
    ["lat(a\u0085b)", true],
    ["lat(inside\u2028break)", false],
    ["lat(inside\u2029break)", false],
    ["lat(x)\r(y)", false],
    ["lat(x)\u2028(y)", false],
    ["lat(x)\u2029(y)", false],
    ["lat(x)\r", true],
    ["lat(x)\u2028", true],
    ["lat(x)\u2029", true],
    ["LAT(deg)", false],
  ])("normalizes the header %j", (latitude, readable) => {
    if (readable) {
      const out = parse(csv(latitude));
      expect(out.observations).toHaveLength(1);
      expect(sealFailures(out.observations)).toEqual([]);
      expect(byLocation(out, 10, 20)["result"]).toMatchObject({ value: 2.5, unit: "MW" });
    } else {
      __resetSkips();
      const out = parse(csv(latitude), csv("lat"));
      expect(out.observations).toHaveLength(1);
      expect(drainSkipped(feed.id)).toEqual({ malformed: 1 });
      expect(() => parse(csv(latitude))).toThrow("none of the 1 granules is an SLSTR FRP file");
    }
  });

  test("unclosed legends complete within a bounded child process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
        import assert from "node:assert/strict";
        const { parseSlstrFrp } = await import(process.argv[1]);
        const { catalogFeed, parseContext } = await import(process.argv[2]);
        const read = (legend) => parseSlstrFrp(catalogFeed("eumetsat-slstr-fires"), {
          fires: [Buffer.from("lat,lon,day,time,FRP,satellite,unused" + legend +
            "\\n10,20,2026-10-16,03:05:00,2.5,S3A,ignored\\n")],
        }, parseContext("2026-10-16T21:00:00Z", 900));
        assert.equal(read("(").observations.length, 1);
        const out = read("(".repeat(100_000));
        assert.equal(out.observations.length, 1);
        assert.equal(out.observations[0].result.value, 2.5);
        console.log("decoded");
      `,
        new URL("../formats/slstr-frp.ts", import.meta.url).href,
        new URL("./helpers/hazards-feed.ts", import.meta.url).href,
      ],
      { encoding: "utf8", timeout: 2000, maxBuffer: 4096 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("decoded");
  });
});
