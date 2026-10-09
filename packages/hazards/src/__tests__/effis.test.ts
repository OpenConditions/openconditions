import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import { effisFeed, fixture, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T21:10:00Z";
const effis = hazardsDomain.formats["effis"]!;
const feed = effisFeed();
const parse = (payloads: FeedPayloads): ParseOutput =>
  effis.parse(feed, payloads, parseContext(FETCHED, 3600));

const byId = (out: ParseOutput, id: string) =>
  out.situations.find((s) => s["id"] === `oc:situation:eu-effis-fires:${id}`) as RecordDraft;
const admin = (s: RecordDraft) => (s["location"] as { admin?: object }).admin;

interface Collection {
  features: { properties: Record<string, unknown>; geometry: unknown }[];
}
const collection = (name: string): Collection =>
  JSON.parse(fixture(name).toString("utf8")) as Collection;
const buffer = (c: unknown) => Buffer.from(JSON.stringify(c));

describe("the effis format over the fit capture", () => {
  const out = parse({ main: [fixture("effis-burnt-areas.geojson")] });

  test("burnt areas seal as wildfire / burned_area situations", () => {
    expect(out.situations).toHaveLength(2);
    expect(out.rejected).toBeUndefined();
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations[0]).toMatchObject({
      id: "oc:situation:eu-effis-fires:785074",
      kind: "natural_hazard",
      type: "wildfire",
      subtype: "burned_area",
      planned: false,
      certainty: "observed",
      location: {
        extent: "area",
        geometryOrigin: "source",
        admin: { country: "PT", municipality: "Anjos e Vilar do Chão" },
      },
      validity: { status: "unknown", start: "2026-09-23T20:00:00Z" },
      provenance: {
        sourceId: "eu-effis-fires",
        sourceFormat: "effis",
        recordId: "785074",
        sourceUpdatedAt: "2026-09-29T07:55:02Z",
      },
      details: { areaHa: 1, discoveredAt: "2026-09-23T20:00:00Z" },
    });
  });

  test("EFFIS's class and land-cover shares are extras, as numbers", () => {
    expect(byId(out, "785132")["extras"]).toEqual({
      class: "30DAYS",
      province: "Cosenza",
      broadleavedPct: 0,
      coniferPct: 0,
      mixedForestPct: 0,
      sclerophyllousPct: 0,
      transitionalPct: 0,
      otherNaturalPct: 0,
      agriculturalPct: 99.99999998999999,
      artificialPct: 0,
      otherLandCoverPct: 0,
      natura2000Pct: 0,
    });
  });

  test("the accounting holds every feature as accepted", () => {
    expect(out.records).toMatchObject({
      inputCount: 2,
      uniqueCount: 2,
      duplicates: 0,
      accepted: 2,
      terminal: 0,
    });
  });
});

describe("the effis format over EU-style countries and missing values", () => {
  const out = parse({ main: [fixture("effis-el-ks-zero.geojson")] });

  test("EL is Greece and KS is Kosovo", () => {
    expect(admin(byId(out, "820007"))).toEqual({
      country: "GR",
      municipality: "Τοπική Κοινότητα Κορθίου",
    });
    expect(admin(byId(out, "809756"))).toEqual({ country: "XK" });
    expect(sealFailures(out.situations)).toEqual([]);
  });

  test('"N.A." is no commune and no province', () => {
    expect(byId(out, "809756")["extras"]).not.toHaveProperty("province");
    expect(byId(out, "820007")["extras"]).toMatchObject({
      province: "Άνδρος, Θήρα, Κέα, Μήλος, Μύκονος, Νάξος, Πάρος, Σύρος, Τήνος",
    });
  });

  test('AREA_HA "0" is an area of zero hectares', () => {
    expect(byId(out, "819925")["details"]).toMatchObject({ areaHa: 0 });
    expect(byId(out, "809756")["details"]).toMatchObject({ areaHa: 7 });
  });

  test("zone-less times are UTC, to the second", () => {
    expect(byId(out, "820007")).toMatchObject({
      validity: { status: "unknown", start: "2026-10-02T00:00:00Z" },
      provenance: { sourceUpdatedAt: "2026-10-08T08:36:31Z" },
    });
  });

  test("UK is Great Britain and an unknown two-letter code is kept", () => {
    const c = collection("effis-el-ks-zero.geojson");
    c.features[0]!.properties["COUNTRY"] = "UK";
    c.features[1]!.properties["COUNTRY"] = "TN";
    c.features[2]!.properties["COUNTRY"] = "N.A.";
    const altered = parse({ main: [buffer(c)] });
    expect(admin(byId(altered, "820007"))).toMatchObject({ country: "GB" });
    expect(admin(byId(altered, "809756"))).toEqual({ country: "TN" });
    expect(admin(byId(altered, "819925"))).toBeUndefined();
    expect(sealFailures(altered.situations)).toEqual([]);
  });

  test("UPDATED wins over LASTUPDATE, and a padded area string reads", () => {
    const c = collection("effis-el-ks-zero.geojson");
    c.features[0]!.properties["UPDATED"] = "2026-10-08 12:00:00";
    c.features[0]!.properties["AREA_HA"] = " 123.5 ";
    const altered = parse({ main: [buffer(c)] });
    expect(byId(altered, "820007")).toMatchObject({
      provenance: { sourceUpdatedAt: "2026-10-08T12:00:00Z" },
      details: { areaHa: 123.5 },
    });
  });
});

describe("the effis format over features that do not read", () => {
  test("a feature with no id, polygon or fire date is rejected, the rest publish", () => {
    const c = collection("effis-el-ks-zero.geojson");
    const [a, b, d] = c.features as [Collection["features"][0], ...Collection["features"]];
    c.features = [
      a,
      { properties: { ...b!.properties, id: undefined }, geometry: b!.geometry },
      { properties: b!.properties, geometry: { type: "Point", coordinates: [1, 2] } },
      { properties: { ...d!.properties, FIREDATE: "N.A." }, geometry: d!.geometry },
      {
        properties: { ...d!.properties, id: "A1", FIREDATE: "2026-10-01 00:00:00" },
        geometry: d!.geometry,
      },
      { properties: { ...d!.properties, id: "A1" }, geometry: d!.geometry },
    ];
    const out = parse({ main: [buffer(c)] });
    expect(out.situations).toHaveLength(2);
    expect(out.rejected).toBe(3);
    expect(out.records).toMatchObject({
      inputCount: 6,
      uniqueCount: 5,
      duplicates: 1,
      accepted: 2,
    });
  });

  test("an update time that does not read falls through to the last-update time", () => {
    const c = collection("effis-burnt-areas.geojson");
    const [first, second] = c.features as [Collection["features"][0], Collection["features"][0]];
    first.properties["UPDATED"] = "N.A.";
    second.properties["UPDATED"] = "2026-09-30 01:02:03";
    const out = parse({ main: [buffer(c)] });
    expect(
      out.situations.map((s) => (s["provenance"] as { sourceUpdatedAt: string }).sourceUpdatedAt),
    ).toEqual(["2026-09-29T07:55:02Z", "2026-09-30T01:02:03Z"]);
  });

  test("an empty week is an accounted zero", () => {
    const out = parse({ main: [Buffer.from('{"type":"FeatureCollection","features":[]}')] });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 0, accepted: 0 });
  });
});

describe("the effis format over an answer that is no layer", () => {
  test("an OGC ExceptionReport fails the parse and names the reason", () => {
    expect(() => parse({ main: [fixture("effis-exception-report.xml")] })).toThrow(
      /OGC exception: .*TYPENAME 'ms:nonexistent' could not be found/,
    );
  });

  test("a body without features fails the parse", () => {
    expect(() => parse({ main: [Buffer.from('{"message":"Forbidden"}')] })).toThrow(
      /no feature collection/,
    );
  });
});
