import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { hazardsDomain } from "../domain.js";
import { eonetFeed, fixture, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-09T01:15:00Z";
const eonet = hazardsDomain.formats["eonet"]!;
const feed = eonetFeed();
const parse = (payloads: FeedPayloads, fetchedAt = FETCHED): ParseOutput =>
  eonet.parse(feed, payloads, parseContext(fetchedAt, 900));

const byId = (out: ParseOutput, id: string) =>
  out.situations.find((s) => s["id"] === `oc:situation:nasa-eonet-events:${id}`) as RecordDraft;

interface Event {
  id: string;
  closed: string | null;
  sources: { id: string; url: string }[];
  geometry: { type: string; date: string; coordinates: unknown }[];
}
const events = (name: string): { events: Event[] } =>
  JSON.parse(fixture(name).toString("utf8")) as { events: Event[] };
const buffer = (c: unknown) => Buffer.from(JSON.stringify(c));

describe("the eonet format over the live captures", () => {
  const out = parse({
    open: [fixture("eonet-open.json")],
    closed: [fixture("eonet-closed.json"), fixture("eonet-closed-volcano.json")],
  });

  test("the events seal, the GDACS-sourced ones are terminal", () => {
    expect(out.situations.map((s) => s["id"])).toEqual([
      "oc:situation:nasa-eonet-events:EONET_20822",
      "oc:situation:nasa-eonet-events:EONET_20710",
      "oc:situation:nasa-eonet-events:EONET_6288",
      "oc:situation:nasa-eonet-events:EONET_19906",
    ]);
    expect(out.rejected).toBeUndefined();
    expect(out.records).toMatchObject({
      inputCount: 6,
      uniqueCount: 6,
      duplicates: 0,
      accepted: 4,
      terminal: 2,
    });
    expect(sealFailures(out.situations)).toEqual([]);
  });

  test("the GDACS-sourced flood and volcano are skipped", () => {
    expect(byId(out, "EONET_25047")).toBeUndefined();
    expect(byId(out, "EONET_980")).toBeUndefined();
  });

  test("the volcano is a volcano with its source page, at its only position", () => {
    expect(byId(out, "EONET_20710")).toMatchObject({
      kind: "natural_hazard",
      type: "volcano",
      temporality: "live",
      certainty: "observed",
      severity: { label: "unknown" },
      headline: [{ lang: "en", text: "Nevados del Chillan Volcano, Chile" }],
      location: {
        geometry: { type: "Point", coordinates: [-71.378, -36.868] },
        extent: "point",
        geometryOrigin: "source",
      },
      details: {
        name: [{ lang: "en", text: "Nevados del Chillan Volcano, Chile" }],
        detailUrl: "https://volcano.si.edu/volcano.cfm?vn=357070",
      },
      provenance: { sourceId: "nasa-eonet-events", recordId: "EONET_20710" },
    });
  });

  test("the iceberg is sea ice / iceberg at its latest position with its area", () => {
    expect(byId(out, "EONET_6288")).toMatchObject({
      type: "sea_ice",
      subtype: "iceberg",
      location: { geometry: { type: "Point", coordinates: [-38.41, -56.49] } },
      validity: { status: "active", start: "2022-10-21T00:00:00Z" },
      details: { areaHa: 18521.46, detailUrl: "https://usicecenter.gov/pub/Iceberg_Tabular.csv" },
    });
    expect(byId(out, "EONET_6288")["validity"]).not.toHaveProperty("end");
  });

  test("an open event is no longer going on once its last position is older than its window", () => {
    expect(byId(out, "EONET_20822")["validity"]).toEqual({
      status: "ended",
      start: "2026-06-25T00:00:00Z",
      end: "2026-08-22T00:00:00Z",
    });
    expect(byId(out, "EONET_20710")["validity"]).toEqual({
      status: "ended",
      start: "2026-06-15T00:00:00Z",
      end: "2026-09-13T00:00:00Z",
    });
  });

  test("a closed event ends at its closing date", () => {
    expect(byId(out, "EONET_19906")).toMatchObject({
      type: "volcano",
      validity: { status: "ended", start: "2026-03-08T00:00:00Z", end: "2026-04-12T00:00:00Z" },
    });
  });

  test("no event expires on its own: a window read finds it", () => {
    for (const s of out.situations) expect(s["freshness"]).toEqual({ fetchedAt: FETCHED });
  });
});

describe("the eonet format over the windows of an open event", () => {
  const volcano = () => ({
    events: events("eonet-open.json").events.filter((e) => e.id === "EONET_20710"),
  });

  test("a volcano last seen 120 days ago has ended 90 days after its last position", () => {
    const out = parse({ open: [buffer(volcano())] }, "2026-10-13T00:00:00Z");
    expect(byId(out, "EONET_20710")["validity"]).toEqual({
      status: "ended",
      start: "2026-06-15T00:00:00Z",
      end: "2026-09-13T00:00:00Z",
    });
  });

  test("a volcano seen inside its window is still active", () => {
    const out = parse({ open: [buffer(volcano())] }, "2026-08-01T00:00:00Z");
    expect(byId(out, "EONET_20710")["validity"]).toEqual({
      status: "active",
      start: "2026-06-15T00:00:00Z",
    });
  });

  test("an event of another type has 14 days", () => {
    const flood = volcano();
    flood.events[0]!.geometry[0]!.date = "2026-10-01T00:00:00Z";
    (flood.events[0] as unknown as { categories: object[] }).categories = [
      { id: "floods", title: "Floods" },
    ];
    const ended = parse({ open: [buffer(flood)] }, "2026-10-16T00:00:00Z");
    expect(byId(ended, "EONET_20710")).toMatchObject({
      type: "flood",
      validity: { status: "ended", end: "2026-10-15T00:00:00Z" },
    });
    const current = parse({ open: [buffer(flood)] }, "2026-10-14T00:00:00Z");
    expect(byId(current, "EONET_20710")["validity"]).toMatchObject({ status: "active" });
  });
});

describe("the eonet format over altered events", () => {
  const flood = () => {
    const { events: list } = events("eonet-closed.json");
    const event = list[0]!;
    event.sources = [{ id: "EO", url: "https://earthobservatory.nasa.gov/event" }];
    (event as unknown as { categories: object[] }).categories = [{ id: "floods", title: "Floods" }];
    return { events: [event] };
  };

  test("a polygon event keeps its polygon and its closing date", () => {
    const out = parse({ open: [Buffer.from('{"events":[]}')], closed: [buffer(flood())] });
    expect(byId(out, "EONET_25047")).toMatchObject({
      type: "flood",
      location: { extent: "area", geometry: { type: "Polygon" } },
      validity: { status: "ended", end: "2026-10-04T00:00:00Z" },
    });
    expect(sealFailures(out.situations)).toEqual([]);
  });

  test("a polygon with a position out of range rejects the record, not the payload", () => {
    const bad = flood();
    const ring = (bad.events[0]!.geometry[0]!.coordinates as number[][][])[0]!;
    ring[2] = [17.7858722, 97.742169];
    const volcano = events("eonet-open.json").events.find((e) => e.id === "EONET_20710")!;
    const out = parse({ open: [buffer({ events: [volcano] })], closed: [buffer(bad)] });
    expect(out.situations).toHaveLength(1);
    expect(out.rejected).toBe(1);
    expect(out.records).toMatchObject({ inputCount: 2, accepted: 1, terminal: 0 });
  });

  test("an event with no dated geometry or no id is rejected and counted", () => {
    const volcano = events("eonet-open.json").events.find((e) => e.id === "EONET_20710")!;
    const out = parse({
      open: [
        buffer({
          events: [
            { ...volcano, id: "EONET_Y", geometry: [] },
            { ...volcano, id: undefined },
            {
              ...volcano,
              id: "EONET_X",
              geometry: [{ ...volcano.geometry[0], date: "yesterday" }],
            },
            volcano,
          ],
        }),
      ],
    });
    expect(out.situations).toHaveLength(1);
    expect(out.rejected).toBe(3);
  });

  test("an event in both lists is one, the closed copy standing", () => {
    const volcano = events("eonet-open.json").events.find((e) => e.id === "EONET_20710")!;
    const out = parse({
      open: [buffer({ events: [volcano] })],
      closed: [buffer({ events: [{ ...volcano, closed: "2026-07-01T00:00:00Z" }] })],
    });
    expect(out.situations).toHaveLength(1);
    expect(out.records).toMatchObject({ inputCount: 2, uniqueCount: 1, duplicates: 1 });
    expect(byId(out, "EONET_20710")["validity"]).toMatchObject({
      status: "ended",
      end: "2026-07-01T00:00:00Z",
    });
  });

  test("categories another source reports first-hand are terminal", () => {
    const volcano = events("eonet-open.json").events.find((e) => e.id === "EONET_20710")!;
    const of = (id: string) => ({ ...volcano, id: `X_${id}`, categories: [{ id, title: id }] });
    const out = parse({
      open: [
        buffer({ events: [of("wildfires"), of("earthquakes"), of("severeStorms"), of("snow")] }),
      ],
    });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 4, accepted: 0, terminal: 4 });
  });

  test("a quiet poll is an accounted zero and a body without events fails the parse", () => {
    const quiet = parse({ open: [Buffer.from('{"events":[]}')] });
    expect(quiet.records).toMatchObject({ inputCount: 0, accepted: 0 });
    expect(() => parse({ open: [Buffer.from('{"message":"down"}')] })).toThrow(/no event list/);
  });
});
