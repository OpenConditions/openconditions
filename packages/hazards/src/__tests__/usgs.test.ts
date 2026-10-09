import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import { fixture, parseContext, usgsFeed } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-09T01:15:00Z";
const usgs = hazardsDomain.formats["usgs"]!;
const feed = usgsFeed();
const parse = (payloads: FeedPayloads): ParseOutput =>
  usgs.parse(feed, payloads, parseContext(FETCHED, 120));

const byId = (out: ParseOutput, id: string) =>
  out.situations.find((s) => s["id"] === `oc:situation:usgs-quakes:${id}`) as RecordDraft;

interface Feature {
  id: string;
  properties: Record<string, unknown>;
  geometry: unknown;
}
interface Collection {
  features: Feature[];
}
const collection = (name: string): Collection =>
  JSON.parse(fixture(name).toString("utf8")) as Collection;
const buffer = (c: unknown) => Buffer.from(JSON.stringify(c));
const feature = (c: Collection, id: string) => c.features.find((f) => f.id === id)!;

describe("the usgs format over the live captures", () => {
  const out = parse({
    recent: [fixture("usgs-all-day.geojson")],
    window: [fixture("usgs-all-month.geojson")],
  });

  test("the union by id keeps the earthquakes and seals", () => {
    expect(out.situations.map((s) => s["id"])).toEqual([
      "oc:situation:usgs-quakes:aka2026typggm",
      "oc:situation:usgs-quakes:us6000u0xi",
      "oc:situation:usgs-quakes:uu80158811",
      "oc:situation:usgs-quakes:us6000u0x4",
      "oc:situation:usgs-quakes:us6000ty43",
    ]);
    expect(out.rejected).toBeUndefined();
    expect(sealFailures(out.situations)).toEqual([]);
  });

  test("the quarry blast and the explosion are terminal, the repeats are duplicates", () => {
    expect(out.records).toMatchObject({
      inputCount: 9,
      uniqueCount: 7,
      duplicates: 2,
      accepted: 5,
      terminal: 2,
    });
    expect(byId(out, "ci41345175")).toBeUndefined();
    expect(byId(out, "uw714118181")).toBeUndefined();
  });

  test("us6000u0xi maps with PAGER green as minor and both of its ids", () => {
    expect(byId(out, "us6000u0xi")).toMatchObject({
      kind: "natural_hazard",
      type: "earthquake",
      temporality: "live",
      planned: false,
      certainty: "observed",
      severity: { label: "minor", source: "declared", declaredRaw: "green" },
      headline: [{ lang: "en", text: "M 6.3 - 102 km NE of Norsup, Vanuatu" }],
      externalIds: [
        { scheme: "usgs:event", id: "pt26281001" },
        { scheme: "usgs:event", id: "us6000u0xi" },
      ],
      location: {
        geometry: { type: "Point", coordinates: [168.1889, -15.5411] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      validity: {
        status: "ended",
        start: "2026-10-08T09:00:07.768Z",
        end: "2026-10-08T09:00:07.768Z",
      },
      provenance: {
        sourceId: "usgs-quakes",
        sourceFormat: "usgs",
        recordId: "us6000u0xi",
        sourceUpdatedAt: "2026-10-09T01:11:10.737Z",
      },
      details: {
        name: [{ lang: "en", text: "102 km NE of Norsup, Vanuatu" }],
        detailUrl: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u0xi",
        magnitude: { value: 6.3, scale: "mww" },
        depth: { value: 10000, unit: "m" },
        tsunamiFlag: false,
        feltReports: 5,
        mmi: 7.654,
        reviewed: true,
      },
    });
  });

  test("an earthquake carries no expiry, so a window read finds it", () => {
    for (const s of out.situations) {
      expect(s["freshness"]).toEqual({ fetchedAt: FETCHED });
    }
  });

  test("a depth above sea level stays negative", () => {
    expect(byId(out, "uu80158811")["details"]).toMatchObject({
      depth: { value: -3370, unit: "m" },
    });
  });

  test("the tsunami flag is the publisher's flag", () => {
    expect(byId(out, "us6000ty43")["details"]).toMatchObject({ tsunamiFlag: true });
    expect(byId(out, "us6000ty43")["externalIds"]).toEqual([
      { scheme: "usgs:event", id: "attm2hmu" },
      { scheme: "usgs:event", id: "us6000ty43" },
    ]);
  });

  test("an event without a PAGER alert has unknown severity", () => {
    expect(byId(out, "uu80158811")["severity"]).toEqual({ label: "unknown" });
    expect(byId(out, "uu80158811")["details"]).not.toHaveProperty("feltReports");
    expect(byId(out, "uu80158811")["details"]).not.toHaveProperty("mmi");
  });
});

describe("the usgs format over merged and altered features", () => {
  test("the recent copy with the later updated wins over the window", () => {
    const month = collection("usgs-all-month.geojson");
    const stale = feature(month, "us6000u0xi");
    stale.properties["updated"] = (stale.properties["updated"] as number) - 600_000;
    stale.properties["mag"] = 6.0;
    const out = parse({
      recent: [fixture("usgs-all-day.geojson")],
      window: [buffer(month)],
    });
    expect(byId(out, "us6000u0xi")["details"]).toMatchObject({
      magnitude: { value: 6.3, scale: "mww" },
    });
  });

  test("the window copy wins when it is the later revision", () => {
    const month = collection("usgs-all-month.geojson");
    const revised = feature(month, "us6000u0xi");
    revised.properties["updated"] = (revised.properties["updated"] as number) + 600_000;
    revised.properties["mag"] = 6.4;
    const out = parse({
      recent: [fixture("usgs-all-day.geojson")],
      window: [buffer(month)],
    });
    expect(byId(out, "us6000u0xi")["details"]).toMatchObject({ magnitude: { value: 6.4 } });
    expect(out.situations).toHaveLength(5);
  });

  test("two features sharing an ids entry are one event under the newer one's id", () => {
    const out = parse({
      recent: [fixture("usgs-all-day.geojson")],
      window: [fixture("usgs-constructed.geojson")],
    });
    expect(byId(out, "us6000u10t")).toBeUndefined();
    expect(byId(out, "aka2026typggm")).toMatchObject({
      externalIds: [
        { scheme: "usgs:event", id: "us6000u10t" },
        { scheme: "usgs:event", id: "aka2026typggm" },
      ],
      provenance: { recordId: "aka2026typggm" },
    });
    expect(out.situations.filter((s) => s["type"] === "earthquake")).toHaveLength(3);
    expect(out.records!.situationRecords["oc:situation:usgs-quakes:aka2026typggm"]).toBe(2);
    expect(out.records).toMatchObject({ inputCount: 6, duplicates: 0, accepted: 3, terminal: 2 });
  });

  test("the newer feature of a shared event stands whichever role holds it", () => {
    const out = parse({
      recent: [fixture("usgs-constructed.geojson")],
      window: [fixture("usgs-all-day.geojson")],
    });
    expect(byId(out, "aka2026typggm")).toBeDefined();
    expect(byId(out, "us6000u10t")).toBeUndefined();
  });

  test("a null magnitude leaves the magnitude out and the rest of the record", () => {
    const out = parse({
      recent: [fixture("usgs-all-day.geojson")],
      window: [fixture("usgs-constructed.geojson")],
    });
    const details = byId(out, "uu80158811")["details"] as Record<string, unknown>;
    expect(details).not.toHaveProperty("magnitude");
    expect(details).toMatchObject({ depth: { value: -3370, unit: "m" }, reviewed: true });
    expect(sealFailures(out.situations)).toEqual([]);
  });

  test("a detail page that is no http(s) URL is left out", () => {
    const c = collection("usgs-all-day.geojson");
    const [first, second] = c.features.filter((f) => f.properties["type"] === "earthquake") as [
      Feature,
      Feature,
    ];
    first.properties["url"] = "javascript:alert(1)";
    second.properties["url"] = "data:text/html,boom";
    const features = [first, second];
    const out = parse({
      recent: [buffer({ ...c, features })],
      window: [buffer({ ...c, features })],
    });
    expect(out.situations).toHaveLength(2);
    for (const s of out.situations) {
      expect(s["details"] as Record<string, unknown>).not.toHaveProperty("detailUrl");
    }
  });

  test("PAGER levels map to the four severities", () => {
    const day = collection("usgs-all-day.geojson");
    const base = feature(day, "us6000u0xi");
    const levels = ["yellow", "orange", "red"].map((alert, i) => ({
      ...base,
      id: `pager${i}`,
      properties: { ...base.properties, alert, ids: `,pager${i},` },
    }));
    const out = parse({ recent: [buffer({ features: levels })], window: [] });
    expect(out.situations.map((s) => s["severity"])).toEqual([
      { label: "moderate", source: "declared", declaredRaw: "yellow" },
      { label: "major", source: "declared", declaredRaw: "orange" },
      { label: "critical", source: "declared", declaredRaw: "red" },
    ]);
  });

  test("features without an id, a position or an origin time are rejected and counted", () => {
    const day = collection("usgs-all-day.geojson");
    const base = feature(day, "us6000u0xi");
    const out = parse({
      recent: [
        buffer({
          features: [
            { ...base, id: undefined },
            { ...base, id: "badpoint", geometry: { type: "Point", coordinates: [200, 10, 5] } },
            { ...base, id: "notime", properties: { ...base.properties, time: null } },
            base,
          ],
        }),
      ],
      window: [],
    });
    expect(out.situations).toHaveLength(1);
    expect(out.rejected).toBe(3);
    expect(out.records).toMatchObject({ inputCount: 4, uniqueCount: 4, accepted: 1 });
  });

  test("a quiet poll is an accounted zero", () => {
    const out = parse({ recent: [buffer({ features: [] })], window: [buffer({ features: [] })] });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 0, accepted: 0, terminal: 0 });
  });

  test("a body that is no feature collection fails the parse", () => {
    expect(() => parse({ recent: [Buffer.from('{"error":"down"}')], window: [] })).toThrow(
      /no feature collection/,
    );
  });
});
