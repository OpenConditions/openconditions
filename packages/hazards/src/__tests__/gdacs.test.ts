import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import { fixture, gdacsFeed, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-09T01:15:00Z";
const gdacs = hazardsDomain.formats["gdacs"]!;
const feed = gdacsFeed();
const parse = (payloads: FeedPayloads): ParseOutput =>
  gdacs.parse(feed, payloads, parseContext(FETCHED, 600));

const byId = (out: ParseOutput, id: string) =>
  out.situations.find((s) => s["id"] === `oc:situation:gdacs-events:${id}`) as RecordDraft;
const geometry = (s: RecordDraft) =>
  (s["location"] as { geometry: { type: string; coordinates: unknown[] } }).geometry;

describe("the gdacs format over the live captures", () => {
  const out = parse({
    events: [fixture("gdacs-rss.xml")],
    areas: [fixture("gdacs-cap.xml")],
  });

  test("cyclones, floods, the volcano and droughts seal; earthquakes and wildfires are terminal", () => {
    expect(out.situations.map((s) => (s["provenance"] as { recordId: string }).recordId)).toEqual([
      "TC1001334",
      "TC1001335",
      "TC1001333",
      "FL1104169",
      "FL1104213",
      "FL1104203",
      "VO1000151",
      "DR1018332",
      "DR1027450",
    ]);
    expect(out.rejected).toBeUndefined();
    expect(out.records).toMatchObject({
      inputCount: 11,
      uniqueCount: 11,
      duplicates: 0,
      accepted: 9,
      terminal: 2,
    });
    expect(sealFailures(out.situations)).toEqual([]);
  });

  test("the hurricane has its wind and the wind-buffer MultiPolygon of its current episode", () => {
    const tc = byId(out, "TC1001334");
    expect(tc).toMatchObject({
      kind: "natural_hazard",
      type: "tropical_cyclone",
      subtype: "hurricane",
      certainty: "observed",
      severity: { label: "minor", source: "declared", declaredRaw: "Green", level: 1 },
      externalIds: [{ scheme: "gdacs:event", id: "TC1001334" }],
      location: { extent: "area", geometryOrigin: "source" },
      validity: { status: "active", start: "2026-10-06T21:00:00Z" },
      details: {
        name: [{ lang: "en", text: "ISAIAS-26" }],
        maxWind: { value: 176, unit: "km/h" },
        populationAffected: 913643,
        detailUrl: "https://www.gdacs.org/report.aspx?eventtype=TC&eventid=1001334",
      },
      provenance: {
        sourceId: "gdacs-events",
        sourceFormat: "gdacs",
        recordId: "TC1001334",
        sourceUpdatedAt: expect.stringMatching(/^2026-10-/),
      },
    });
    expect(geometry(tc).type).toBe("MultiPolygon");
    expect(geometry(tc).coordinates).toHaveLength(1);
    // CAP writes lat,lon; the stored polygon is [lon, lat].
    const ring = (geometry(tc).coordinates[0] as number[][][])[0]!;
    expect(ring[0]![0]).toBeLessThan(0);
    expect(ring[0]![1]).toBeGreaterThan(0);
  });

  test("a cyclone's subtype follows its severity text and basin", () => {
    expect(byId(out, "TC1001335")).toMatchObject({
      subtype: "tropical_storm",
      severity: { label: "major", declaredRaw: "Orange", level: 2 },
      details: { maxWind: { value: 213, unit: "km/h" }, populationAffected: 111104 },
    });
    expect(byId(out, "TC1001333")).toMatchObject({ subtype: "typhoon" });
  });

  test("a cyclone without CAP areas keeps its RSS point", () => {
    expect(byId(out, "TC1001333")).toMatchObject({
      location: {
        geometry: { type: "Point", coordinates: [157.7, 18.1] },
        extent: "point",
      },
    });
  });

  test("a flood with several areas is one MultiPolygon of them all", () => {
    const fl = byId(out, "FL1104203");
    expect(fl).toMatchObject({ type: "flood" });
    expect(geometry(fl).type).toBe("MultiPolygon");
    expect(geometry(fl).coordinates).toHaveLength(2);
  });

  test("an item that is no longer current has ended at its todate", () => {
    expect(byId(out, "FL1104213")["validity"]).toEqual({
      status: "ended",
      start: "2026-10-03T01:00:00Z",
      end: "2026-10-05T01:00:00Z",
    });
    expect(byId(out, "DR1027450")["validity"]).toMatchObject({
      status: "ended",
      end: "2026-10-06T00:00:00Z",
    });
    expect(byId(out, "FL1104169")["validity"]).toEqual({
      status: "active",
      start: "2026-10-05T01:00:00Z",
    });
  });

  test("the volcano carries its GLIDE number and the people near it", () => {
    expect(byId(out, "VO1000151")).toMatchObject({
      type: "volcano",
      severity: { label: "major", level: 2 },
      externalIds: [
        { scheme: "gdacs:event", id: "VO1000151" },
        { scheme: "glide", id: "VO-2026-000187-PHL" },
      ],
      location: { geometry: { type: "Point", coordinates: [120.9975, 14.0106] } },
      details: { name: [{ lang: "en", text: "Taal" }], populationAffected: 3502937 },
    });
    expect(byId(out, "VO1000151")["details"]).not.toHaveProperty("maxWind");
  });

  test("a drought is a drought with its country list as the name", () => {
    expect(byId(out, "DR1018332")).toMatchObject({
      type: "drought",
      details: { name: [{ lang: "en", text: "Europe-2026" }] },
    });
  });

  test("no event expires on its own", () => {
    for (const s of out.situations) expect(s["freshness"]).toEqual({ fetchedAt: FETCHED });
  });
});

describe("the gdacs format without areas and over altered documents", () => {
  const rss = () => fixture("gdacs-rss.xml").toString("utf8");

  test("without the areas role every event keeps its point", () => {
    const out = parse({ events: [fixture("gdacs-rss.xml")] });
    expect(out.situations).toHaveLength(9);
    expect(byId(out, "TC1001334")).toMatchObject({
      location: { geometry: { type: "Point", coordinates: [-89.3, 24.4] }, extent: "point" },
    });
    expect(byId(out, "TC1001334")).toMatchObject({ subtype: "hurricane" });
  });

  test("only the current episode's areas are taken", () => {
    const cap = fixture("gdacs-cap.xml")
      .toString("utf8")
      .replace("GDACS_TC_1001334_9", "GDACS_TC_1001334_8");
    const out = parse({ events: [fixture("gdacs-rss.xml")], areas: [Buffer.from(cap)] });
    expect(geometry(byId(out, "TC1001334")).type).toBe("Point");
  });

  test("a CAP polygon that does not close contributes nothing", () => {
    const cap = fixture("gdacs-cap.xml")
      .toString("utf8")
      .replace(/(<cap:polygon>)(\S+ )/g, (_m, tag: string) => `${tag}1,1 `);
    const out = parse({ events: [fixture("gdacs-rss.xml")], areas: [Buffer.from(cap)] });
    expect(geometry(byId(out, "TC1001334")).type).toBe("Point");
    expect(out.rejected).toBeUndefined();
  });

  test("an item with a repeated guid is a duplicate; one without a time or point is rejected", () => {
    const items = rss().split("<item>").slice(1);
    const taal = `<item>${items.find((i) => i.includes("VO1000151"))!.split("</item>")[0]}</item>`;
    const noTime = taal
      .replace("VO1000151", "VO1000152")
      .replace(/<gdacs:eventid>1000151/, "<gdacs:eventid>1000152")
      .replace(/<gdacs:fromdate>[^<]*/, "<gdacs:fromdate>soon");
    const noPoint = taal
      .replace(/<gdacs:eventid>1000151/, "<gdacs:eventid>1000153")
      .replace(/<geo:lat>[^<]*/, "<geo:lat>95")
      .replace(/<georss:point>[^<]*/, "<georss:point>95 10");
    const out = parse({
      events: [
        Buffer.from(
          `<rss version="2.0" xmlns:gdacs="http://www.gdacs.org" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:georss="http://www.georss.org/georss"><channel>${taal}${taal}${noTime}${noPoint}</channel></rss>`,
        ),
      ],
    });
    expect(out.situations).toHaveLength(1);
    expect(out.rejected).toBe(2);
    expect(out.records).toMatchObject({
      inputCount: 4,
      uniqueCount: 3,
      duplicates: 1,
      accepted: 1,
    });
  });

  test("a feed with no items is an accounted zero", () => {
    const out = parse({
      events: [Buffer.from('<rss version="2.0"><channel><title>GDACS</title></channel></rss>')],
    });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 0, accepted: 0, terminal: 0 });
  });

  test("a document that is no RSS channel fails the parse", () => {
    expect(() => parse({ events: [Buffer.from("<html><body>Maintenance</body></html>")] })).toThrow(
      /no RSS channel/,
    );
    expect(() =>
      parse({
        events: [fixture("gdacs-rss.xml")],
        areas: [Buffer.from("<html><body>Maintenance</body></html>")],
      }),
    ).toThrow(/no RSS channel/);
  });

  test("entity declarations are refused", () => {
    expect(() =>
      parse({ events: [Buffer.from('<!DOCTYPE rss [<!ENTITY a "b">]><rss><channel/></rss>')] }),
    ).toThrow(/entity/);
  });
});
