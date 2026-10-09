import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import { fixture, hmsFeed, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T21:10:00Z";
const hms = hazardsDomain.formats["hms"]!;
const feed = hmsFeed();
const parse = (payloads: FeedPayloads, at = FETCHED): ParseOutput =>
  hms.parse(feed, payloads, parseContext(at, 600));

const byId = (out: ParseOutput, id: string) =>
  out.situations.find((s) => s["id"] === `oc:situation:us-noaa-hms-smoke:${id}`) as RecordDraft;

interface Collection {
  features: { properties: Record<string, unknown>; geometry: unknown }[];
}
const collection = (): Collection =>
  JSON.parse(fixture("hms-smoke.geojson").toString("utf8")) as Collection;
const buffer = (c: unknown) => Buffer.from(JSON.stringify(c));
const only = (properties: Record<string, unknown>, at?: string) => {
  const c = collection();
  c.features = [
    {
      properties: { ...c.features[0]!.properties, ...properties },
      geometry: c.features[0]!.geometry,
    },
  ];
  return parse({ main: [buffer(c)] }, at);
};

describe("the hms format over the captured layer", () => {
  const out = parse({ main: [fixture("hms-smoke.geojson")] });

  test("each polygon is an active smoke situation that seals", () => {
    expect(out.situations.map((s) => String(s["id"]).split(":").at(-1))).toEqual([
      "2026273-2",
      "2026273-35",
      "2026273-73",
    ]);
    expect(out.rejected).toBeUndefined();
    expect(sealFailures(out.situations)).toEqual([]);
  });

  test("a polygon expires a day after its analysis started, should no poll hold it again", () => {
    expect(byId(out, "2026273-2")["freshness"]).toEqual({
      fetchedAt: FETCHED,
      expiresAt: "2026-10-01T12:00:00Z",
    });
    expect(byId(out, "2026273-73")["freshness"]).toMatchObject({
      expiresAt: "2026-10-01T15:00:00Z",
    });
  });

  test("validity starts with the analysis and never ends; the window is the detection", () => {
    const s = byId(out, "2026273-2");
    expect(s["validity"]).toEqual({ status: "active", start: "2026-09-30T12:00:00Z" });
    expect(s).toMatchObject({
      kind: "natural_hazard",
      type: "smoke",
      certainty: "observed",
      location: { extent: "area", geometryOrigin: "source" },
      details: {
        density: "light",
        detection: {
          satellite: "GOES-WEST",
          start: "2026-09-30T12:00:00Z",
          end: "2026-09-30T15:00:00Z",
        },
      },
      provenance: { sourceId: "us-noaa-hms-smoke", sourceFormat: "hms", recordId: "2026273-2" },
    });
  });

  test("a polygon whose image sequence ended at 15:00 is still active at 18:00", () => {
    const later = parse({ main: [fixture("hms-smoke.geojson")] }, "2026-09-30T18:00:00Z");
    expect(byId(later, "2026273-2")["validity"]).toEqual({
      status: "active",
      start: "2026-09-30T12:00:00Z",
    });
  });

  test("the densities are lower-cased", () => {
    expect(out.situations.map((s) => (s["details"] as { density: string }).density)).toEqual([
      "light",
      "medium",
      "heavy",
    ]);
    expect(byId(out, "2026273-73")["details"]).toMatchObject({
      detection: {
        satellite: "GOES-EAST",
        start: "2026-09-30T15:00:00Z",
        end: "2026-09-30T17:00:00Z",
      },
    });
  });

  test("the accounting holds every polygon as accepted", () => {
    expect(out.records).toMatchObject({ inputCount: 3, uniqueCount: 3, accepted: 3, terminal: 0 });
  });
});

describe("the hms ordinal times", () => {
  test("day 366 reads in a leap year and the polygon is rejected otherwise", () => {
    const leap = only({ FID: 7, Start: "2028366 2330", End_: "2028366 2359" });
    expect(leap.situations).toHaveLength(1);
    expect(byId(leap, "2028366-7")["validity"]).toEqual({
      status: "active",
      start: "2028-12-31T23:30:00Z",
    });
    expect(byId(leap, "2028366-7")["details"]).toMatchObject({
      detection: { end: "2028-12-31T23:59:00Z" },
    });
    const common = only({ FID: 7, Start: "2026366 2330", End_: "2026366 2359" });
    expect(common.situations).toEqual([]);
    expect(common.rejected).toBe(1);
    expect(only({ FID: 7, Start: "1900366 0000" }).situations).toEqual([]);
    expect(only({ FID: 7, Start: "2000366 0000" }).situations).toHaveLength(1);
  });

  test("an hour or minute out of range, or day 0, is no time", () => {
    for (const Start of [
      "2026273 2400",
      "2026273 1260",
      "2026000 1200",
      "2026273",
      "2026-273 1200",
      "",
    ]) {
      expect(only({ Start }).rejected, Start).toBe(1);
    }
  });

  test("an end that does not read leaves the detection open at its end", () => {
    const out = only({ FID: 9, End_: "bad" });
    expect(byId(out, "2026273-9")["details"]).toMatchObject({
      detection: { start: "2026-09-30T12:00:00Z" },
    });
    expect(
      (byId(out, "2026273-9")["details"] as { detection: object }).detection,
    ).not.toHaveProperty("end");
  });
});

describe("the hms format over polygons that do not read", () => {
  test("an unknown density, a missing FID or a bad shape is rejected, the rest publish", () => {
    const c = collection();
    const first = c.features[0]!;
    c.features.push(
      {
        properties: { ...first.properties, FID: 90, Density: "Extreme" },
        geometry: first.geometry,
      },
      { properties: { ...first.properties, FID: null }, geometry: first.geometry },
      {
        properties: { ...first.properties, FID: 92 },
        geometry: { type: "Point", coordinates: [1, 2] },
      },
      { properties: { ...first.properties, FID: 2 }, geometry: first.geometry },
    );
    const out = parse({ main: [buffer(c)] });
    expect(out.situations).toHaveLength(3);
    expect(out.rejected).toBe(3);
    expect(out.records).toMatchObject({
      inputCount: 7,
      uniqueCount: 6,
      duplicates: 1,
      accepted: 3,
    });
  });

  test("the FID restarts each day, so the same FID on two days is two records", () => {
    const c = collection();
    const first = c.features[0]!;
    c.features.push({
      properties: { ...first.properties, Start: "2026274 1200", End_: "2026274 1500" },
      geometry: first.geometry,
    });
    const out = parse({ main: [buffer(c)] });
    expect(out.situations).toHaveLength(4);
    expect(byId(out, "2026274-2")).toBeDefined();
  });

  test("the empty morning layer is an accounted zero", () => {
    const out = parse({ main: [Buffer.from('{"type":"FeatureCollection","features":[]}')] });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 0, accepted: 0 });
  });

  test("an ArcGIS error at HTTP 200 fails the parse", () => {
    expect(() => parse({ main: [fixture("arcgis-error.json")] })).toThrow(
      /HMS answered an error: 400/,
    );
    expect(() => parse({ main: [Buffer.from('{"type":"FeatureCollection"}')] })).toThrow(
      /no feature collection/,
    );
  });
});
