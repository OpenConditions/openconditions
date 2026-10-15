import type { FeedPayloads, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { vehiclesDomain } from "../domain.js";
import { sealFailures } from "./helpers/seal.js";
import { catalogFeed, fixture, parseContext } from "./helpers/vehicles-feed.js";

/** The fetch the live fixture was captured by. */
const FETCHED = "2026-10-14T23:24:56Z";

const format = vehiclesDomain.formats["digitraffic"]!;
const feed = catalogFeed("fi-digitraffic-maintenance");

const parse = (bodies: (Buffer | string)[], fetchedAt = FETCHED): ParseOutput =>
  format.parse(
    feed,
    { main: bodies.map((b) => Buffer.from(b)) } satisfies FeedPayloads,
    parseContext(fetchedAt),
  );

const tracking = (out: ParseOutput, id: string) =>
  out.observations.find(
    (o) => (o["provenance"] as { recordId: string }).recordId === id,
  ) as RecordDraft;
const value = (r: RecordDraft) => (r["result"] as { value: Record<string, unknown> }).value;
const recordIds = (out: ParseOutput) =>
  out.observations.map((o) => (o["provenance"] as { recordId: string }).recordId);

describe("the digitraffic format over the live capture", () => {
  const out = parse([fixture("fi-digitraffic-maintenance-latest.json")]);

  test("every current tracking is a vehicle position reading that seals; ended ones are left out", () => {
    // 202634237, 202634372 and 202634841 last reported 15 to 47 minutes before the fetch.
    expect(recordIds(out)).toEqual([
      "202634992",
      "202635001",
      "202635025",
      "202635027",
      "202635031",
      "202635032",
      "202635037",
      "202635043",
    ]);
    expect(out.features).toEqual([]);
    expect(out.situations).toEqual([]);
    expect(out.rejected).toBeUndefined();
    expect(sealFailures(out.observations)).toEqual([]);
  });

  test("a reading is an anonymous position at its place, crediting Harja, standing ten minutes from its time", () => {
    expect(tracking(out, "202635031")).toMatchObject({
      class: "observation",
      property: "vehicle.position",
      temporality: "live",
      subject: { kind: "location" },
      location: {
        geometry: { type: "Point", coordinates: [25.507827, 65.017175] },
        extent: "point",
        geometryOrigin: "source",
      },
      provenance: {
        sourceId: "fi-digitraffic-maintenance",
        sourceFormat: "digitraffic",
        accessMode: "bulk",
        recordId: "202635031",
        attribution: {
          provider: "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY",
          license: "CC-BY-4.0",
        },
        upstream: [{ publisher: "Harja/Väylävirasto" }],
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: FETCHED, expiresAt: "2026-10-14T23:30:57Z" },
      phenomenonTime: { instant: "2026-10-14T23:20:57Z" },
      aggregation: "instantaneous",
      extras: { tasks: ["SNOW_PLOUGHING_STICKS_AND_SNOW_FENCES"] },
    });
    expect(value(tracking(out, "202635031"))).toEqual({
      v: 1,
      point: { type: "Point", coordinates: [25.507827, 65.017175] },
      bearingDeg: 5,
    });
  });

  test("no reading names a vehicle or a feature", () => {
    for (const o of out.observations) {
      expect(o["subject"]).toEqual({ kind: "location" });
      expect(JSON.stringify(o)).not.toContain("oc:feature:");
    }
  });

  test("a tracking without a direction has no bearing", () => {
    expect(value(tracking(out, "202635001"))).not.toHaveProperty("bearingDeg");
    expect(value(tracking(out, "202634992"))).toMatchObject({ bearingDeg: 288 });
  });

  test("sanding turns the spreader on without claiming salting", () => {
    expect(value(tracking(out, "202635025"))).toEqual({
      v: 1,
      point: { type: "Point", coordinates: [27.119327, 68.100155] },
      spreaderOn: true,
    });
  });

  test("summer work keeps its task code and claims no activity", () => {
    for (const id of ["202635027", "202635032", "202635037", "202635043"]) {
      const v = value(tracking(out, id));
      expect(v, id).not.toHaveProperty("activity");
      expect(v, id).not.toHaveProperty("plowUp");
      expect(v, id).not.toHaveProperty("spreaderOn");
      expect(tracking(out, id)["extras"], id).toMatchObject({ tasks: [expect.any(String)] });
    }
  });

  test("a time with milliseconds keeps them", () => {
    expect(tracking(out, "202635043")["phenomenonTime"]).toEqual({
      instant: "2026-10-14T23:21:54.200Z",
    });
  });

  test("each reading has its own id, and a second poll restates the same ones", () => {
    const ids = out.observations.map((o) => o["id"]);
    expect(new Set(ids).size).toBe(ids.length);
    const again = parse(
      [fixture("fi-digitraffic-maintenance-latest.json")],
      "2026-10-14T23:25:56Z",
    );
    expect(again.observations.map((o) => o["id"])).toEqual(ids);
  });

  test("a later fetch leaves out the trackings that ended by then", () => {
    // 202635037 reported at 23:21:16 and 202635043 at 23:21:54.2.
    expect(
      recordIds(parse([fixture("fi-digitraffic-maintenance-latest.json")], "2026-10-14T23:31:30Z")),
    ).toEqual(["202635043"]);
    expect(
      parse([fixture("fi-digitraffic-maintenance-latest.json")], "2026-10-14T23:40:00Z")
        .observations,
    ).toEqual([]);
  });
});

describe("the digitraffic format over edited trackings", () => {
  const out = parse([fixture("fi-digitraffic-maintenance-edges.json")]);

  test("a tracking at null island or without a time is rejected; the rest are read", () => {
    expect(recordIds(out)).toEqual([
      "900000001",
      "900000002",
      "900000003",
      "900000004",
      "900000005",
      "900000006",
    ]);
    expect(out.rejected).toBe(2);
    expect(sealFailures(out.observations)).toEqual([]);
  });

  test("ploughing with spot sanding: the plough is down and the spreader on", () => {
    expect(value(tracking(out, "900000001"))).toMatchObject({
      activity: "plowing",
      plowUp: false,
      spreaderOn: true,
      bearingDeg: 359,
    });
    expect(tracking(out, "900000001")["extras"]).toEqual({
      tasks: ["PLOUGHING_AND_SLUSH_REMOVAL", "SPOT_SANDING"],
    });
  });

  test("salting spreads", () => {
    const v = value(tracking(out, "900000002"));
    expect(v).toMatchObject({ activity: "salting", spreaderOn: true });
    expect(v).not.toHaveProperty("plowUp");
  });

  test("a tracking without tasks is a bare position", () => {
    const r = tracking(out, "900000003");
    expect(value(r)).toEqual({
      v: 1,
      point: { type: "Point", coordinates: [24.95, 60.18] },
      bearingDeg: 12,
    });
    expect(r).not.toHaveProperty("extras");
  });

  test("a task the list does not hold is kept verbatim and claims nothing", () => {
    const r = tracking(out, "900000004");
    expect(value(r)).toEqual({ v: 1, point: { type: "Point", coordinates: [24.96, 60.19] } });
    expect(r["extras"]).toEqual({ tasks: ["SNOW_MELTING_WITH_LASERS"] });
  });

  test("the publisher's UNKNOWN task is an unknown activity, and a heading of 360 is north", () => {
    expect(value(tracking(out, "900000005"))).toMatchObject({ activity: "unknown", bearingDeg: 0 });
  });

  test("a line is placed at its last position", () => {
    expect(tracking(out, "900000006")["location"]).toMatchObject({
      geometry: { type: "Point", coordinates: [24.91, 60.11] },
    });
  });
});

describe("the digitraffic format's edges", () => {
  test("an empty collection is no vehicle out", () => {
    const out = parse([JSON.stringify({ type: "FeatureCollection", features: [] })]);
    expect(out.observations).toEqual([]);
    expect(out.rejected).toBeUndefined();
  });

  test("a body that is no feature collection fails the parse", () => {
    expect(() => parse(["<html>busy</html>"])).toThrow(/not JSON/);
    expect(() => parse([JSON.stringify({ status: 400, error: "Bad Request" })])).toThrow(
      /carries no features/,
    );
  });

  test("a time after the fetch is the fetch's", () => {
    const later = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: 1, time: "2026-10-14T23:30:00Z", tasks: ["SALTING"] },
          geometry: { type: "Point", coordinates: [24.94, 60.17, 0] },
        },
      ],
    });
    const [r] = parse([later]).observations;
    expect(r!["phenomenonTime"]).toEqual({ instant: FETCHED });
    expect(r!["freshness"]).toEqual({ fetchedAt: FETCHED, expiresAt: "2026-10-14T23:34:56Z" });
  });
});
