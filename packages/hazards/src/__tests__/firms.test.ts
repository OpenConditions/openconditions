import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import { firmsModisFeed, firmsViirsFeed, fixture, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T21:10:00Z";
const firms = hazardsDomain.formats["firms"]!;
const viirs = firmsViirsFeed();
const modis = firmsModisFeed();
const parse = (feed: typeof viirs, ...bodies: (Buffer | string)[]): ParseOutput =>
  firms.parse(
    feed,
    { main: bodies.map((b) => Buffer.from(b)) } satisfies FeedPayloads,
    parseContext(FETCHED, 3600),
  );

const byLocation = (out: ParseOutput, lat: number, lon: number) =>
  out.observations.find((o) => {
    const [x, y] = (o["location"] as { geometry: { coordinates: number[] } }).geometry
      .coordinates as [number, number];
    return x === lon && y === lat;
  }) as RecordDraft;

const HEADER =
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight";

describe("the firms format over the VIIRS captures", () => {
  const out = parse(viirs, fixture("firms-viirs-n21.csv"), fixture("firms-viirs-n20.csv"));

  test("every row is a fire.frp reading that seals", () => {
    expect(out.observations).toHaveLength(7);
    expect(out.situations).toEqual([]);
    expect(out.rejected).toBeUndefined();
    expect(sealFailures(out.observations)).toEqual([]);
  });

  test("a NOAA-21 row carries its pixel, its brightness temperatures and its confidence code", () => {
    const o = byLocation(out, -0.64101, 12.35023);
    expect(o).toMatchObject({
      class: "observation",
      kind: "observation",
      property: "fire.frp",
      temporality: "live",
      subject: { kind: "location" },
      result: { type: "quantity", value: 0.69, unit: "MW" },
      phenomenonTime: { instant: "2026-10-07T00:01:00Z" },
      aggregation: "instantaneous",
      quality: { supplierCode: "nominal" },
      location: {
        geometry: { type: "Point", coordinates: [12.35023, -0.64101] },
        extent: "point",
        fuzziness: "medium_res",
      },
      extras: {
        instrument: "viirs",
        satellite: "N21",
        brightnessK: 303.36,
        backgroundK: 286.44,
        daynight: "night",
        scan: 0.37,
        track: 0.58,
        version: "2.0NRT",
      },
      provenance: {
        sourceId: "nasa-firms-viirs-fires",
        sourceFormat: "firms",
        accessMode: "bulk",
        recordId: "N21:-0.64101,12.35023:2026-10-07T0001",
      },
    });
    expect(String(o["id"])).toMatch(/^oc:observation:nasa-firms-viirs-fires:[0-9a-f]{64}$/);
  });

  test("a NOAA-20 row reads from the second file", () => {
    expect(byLocation(out, -16.92929, 18.16956)).toMatchObject({
      result: { value: 1.96 },
      phenomenonTime: { instant: "2026-10-07T01:00:00Z" },
      extras: { satellite: "N20" },
    });
  });

  test("a detection stays current for 72 hours after its acquisition", () => {
    expect(byLocation(out, -0.64101, 12.35023)["freshness"]).toEqual({
      fetchedAt: FETCHED,
      expiresAt: "2026-10-10T00:01:00Z",
    });
  });

  test("the same pixel in two polls has the same id", () => {
    const again = parse(viirs, fixture("firms-viirs-n21.csv"));
    expect(again.observations.map((o) => o["id"])).toEqual(
      out.observations.slice(0, 4).map((o) => o["id"]),
    );
  });
});

describe("the firms format over the fit captures", () => {
  test("a low-confidence VIIRS row is kept, with its code", () => {
    const out = parse(viirs, fixture("firms-viirs-snpp.csv"));
    expect(out.observations).toHaveLength(4);
    expect(byLocation(out, 37.47687, 29.30148)["quality"]).toEqual({ supplierCode: "low" });
    expect(byLocation(out, 39.07019, 16.98349)).toMatchObject({
      quality: { supplierCode: "high" },
      extras: { satellite: "N", daynight: "day", brightnessK: 367 },
    });
    expect(sealFailures(out.observations)).toEqual([]);
  });

  test("MODIS confidence is a fraction, its brightness the 21/22 channel, its pixel low resolution", () => {
    const out = parse(modis, fixture("firms-modis.csv"));
    expect(out.observations).toHaveLength(3);
    expect(byLocation(out, 45.15001, 9.94186)).toMatchObject({
      quality: { confidence: 0.2 },
      result: { value: 6.49 },
      location: { fuzziness: "low_res" },
      extras: { instrument: "modis", satellite: "A", brightnessK: 300.18, backgroundK: 284.44 },
      freshness: { expiresAt: "2026-10-02T03:38:00Z" },
    });
    expect(byLocation(out, 55.79964, 33.02452)["quality"]).toEqual({ confidence: 0.92 });
    expect(sealFailures(out.observations)).toEqual([]);
  });

  test("the abbreviated VIIRS confidence letters are kept as the supplier wrote them", () => {
    const row = "10,20,300,0.4,0.4,2026-10-07,0305,N21,h,2.0NRT,280,2.5,D";
    const out = parse(viirs, `${HEADER}\n${row}\n`);
    expect(out.observations[0]!["quality"]).toEqual({ supplierCode: "h" });
  });
});

describe("a row that does not read", () => {
  const good = "10,20,300,0.4,0.4,2026-10-07,0305,N21,nominal,2.0NRT,280,2.5,D";
  const rows = [
    good,
    "NaN,20,300,0.4,0.4,2026-10-07,0305,N21,nominal,2.0NRT,280,2.5,D",
    "95,20,300,0.4,0.4,2026-10-07,0305,N21,nominal,2.0NRT,280,2.5,D",
    "10,181,300,0.4,0.4,2026-10-07,0305,N21,nominal,2.0NRT,280,2.5,D",
    "10,20,300,0.4,0.4,2026-10-32,0305,N21,nominal,2.0NRT,280,2.5,D",
    "10,20,300,0.4,0.4,2026-02-30,0305,N21,nominal,2.0NRT,280,2.5,D",
    "10,20,300,0.4,0.4,2026-10-07,2561,N21,nominal,2.0NRT,280,2.5,D",
    "10,20,300,0.4,0.4,2026-10-07,0305,N21,nominal,2.0NRT,280,-0.1,D",
    "10,20,300,0.4,0.4,2026-10-07,0305,N21,nominal,2.0NRT,280,,D",
    "11,21,299,0.4,0.4,2026-10-07,0305,N21,low,2.0NRT,280,0,N",
  ];
  const out = parse(viirs, `${HEADER}\n${rows.join("\n")}\n`);

  test("is rejected and counted while the rest of the file is kept", () => {
    expect(out.observations).toHaveLength(2);
    expect(out.rejected).toBe(8);
    expect(out.observations.map((o) => (o["result"] as { value: number }).value)).toEqual([2.5, 0]);
  });

  test("an unreadable confidence leaves the reading without quality", () => {
    const odd = parse(
      viirs,
      `${HEADER}\n10,20,300,0.4,0.4,2026-10-07,0305,N21,,2.0NRT,280,2.5,D\n`,
    );
    expect(odd.observations).toHaveLength(1);
    expect(odd.observations[0]).not.toHaveProperty("quality");
    const modisOut = parse(
      modis,
      "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight\n10,20,300,1,1,2026-10-07,305,T,140,6.1NRT,280,2.5,D\n",
    );
    expect(modisOut.observations).toHaveLength(1);
    expect(modisOut.observations[0]).not.toHaveProperty("quality");
    expect(modisOut.observations[0]).toMatchObject({
      phenomenonTime: { instant: "2026-10-07T03:05:00Z" },
    });
  });
});

describe("a file without detections", () => {
  test("the header alone yields no readings and no error", () => {
    const out = parse(viirs, fixture("firms-viirs-header-only.csv"));
    expect(out.observations).toEqual([]);
    expect(out.rejected).toBeUndefined();
  });

  test("a role with no payload yields none either", () => {
    const out = firms.parse(viirs, {}, parseContext(FETCHED, 3600));
    expect(out.observations).toEqual([]);
  });

  test("a body that is no active-fire file fails the parse", () => {
    expect(() => parse(viirs, "<html><body>Service unavailable</body></html>")).toThrow(
      /no active-fire file/,
    );
    expect(() => parse(viirs, "")).toThrow(/no active-fire file/);
    expect(() => parse(viirs, "latitude,longitude,acq_date\n1,2,2026-10-07\n")).toThrow(
      /lacks.*acq_time/,
    );
  });
});
