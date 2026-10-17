import { __resetSkips, drainSkipped, type ParseOutput } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { parseUtmc } from "../formats/utmc.js";
import { fixture, parseContext, utmcFeed } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2012-01-14T10:10:00Z";

function parse(sites: Buffer[], status: Buffer[]): ParseOutput {
  const out = parseUtmc(utmcFeed(), { sites, status }, parseContext(FETCHED, 120));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => String(f["id"]).endsWith(`:${stationId}`));

function readings(out: ParseOutput, stationId: string): Record<string, unknown> {
  const featureId = `oc:feature:gb-eng-netraveldata-parking:${stationId}`;
  return Object.fromEntries(
    out.observations
      .filter((o) => (o["subject"] as { featureId: string }).featureId === featureId)
      .map((o) => [o["property"], (o["result"] as { value: unknown }).value]),
  );
}

const dynamic = (systemCodeNumber: string, occupancy: number | null, stateDescription: string) => ({
  systemCodeNumber,
  dynamics: [{ occupancy, stateDescription, lastUpdated: "2012-01-14T10:05:00.000+0000" }],
});

describe("utmc", () => {
  beforeEach(() => __resetSkips());

  test("UTMC: FULL is full, FAULTY is closed, occupancy above capacity clamps to 0 available", () => {
    const out = parse([fixture("utmc-static-sample.json")], [fixture("utmc-dynamic-sample.json")]);
    expect(readings(out, "CP1")).toEqual({
      "parking.available": 58,
      "parking.occupied": 142,
      "parking.status": "spaces_available",
    });
    expect(readings(out, "CP2")).toEqual({
      "parking.available": 0,
      "parking.occupied": 80,
      "parking.status": "full",
    });

    const states = parse(
      [fixture("utmc-static-sample.json")],
      [json([dynamic("CP1", 230, "ALMOST FULL"), dynamic("CP2", null, "FAULTY")])],
    );
    // 230 cars in 200 spaces: over-full, so none free.
    expect(readings(states, "CP1")).toEqual({
      "parking.available": 0,
      "parking.occupied": 230,
      "parking.status": "almost_full",
    });
    expect(readings(states, "CP2")).toEqual({ "parking.status": "closed" });

    const other = parse(
      [fixture("utmc-static-sample.json")],
      [json([dynamic("CP1", -1, "open"), dynamic("CP2", 10, "CLOSED")])],
    );
    expect(readings(other, "CP1")).toEqual({ "parking.status": "open" });
    expect(readings(other, "CP2")).toMatchObject({ "parking.status": "closed" });
  });

  test("UTMC: readings are dated by the record's last update", () => {
    const out = parse([fixture("utmc-static-sample.json")], [fixture("utmc-dynamic-sample.json")]);
    const reading = out.observations.find((o) =>
      String((o["subject"] as { featureId: string }).featureId).endsWith(":CP1"),
    );
    expect(reading?.["phenomenonTime"]).toEqual({ instant: "2012-01-13T12:19:32.419Z" });
    // A time without an offset is London time: BST (UTC+1) in July, never the server's zone.
    const local = parse(
      [fixture("utmc-static-sample.json")],
      [
        json([
          {
            systemCodeNumber: "CP1",
            dynamics: [
              { occupancy: 10, stateDescription: "SPACES", lastUpdated: "2012-07-14T10:05:00" },
            ],
          },
        ]),
      ],
    );
    expect(local.observations[0]?.["phenomenonTime"]).toEqual({ instant: "2012-07-14T09:05:00Z" });
  });

  test("UTMC: the static table gives the site; a record without a definition is skipped", () => {
    const out = parse([fixture("utmc-static-sample.json")], [fixture("utmc-dynamic-sample.json")]);
    expect(out.features).toHaveLength(2);
    // CP3-NO-DEF has no point; CP-EMPTY holds no dynamics, so nothing of it is lost.
    expect(drainSkipped(utmcFeed().id)).toEqual({ no_geometry: 1 });
    expect(site(out, "CP1")).toMatchObject({
      type: "off_street",
      name: [{ lang: "en", text: "Town Centre" }],
      location: {
        geometry: { coordinates: [-1.62522866852692, 54.9755208253257] },
        address: { text: "Car park in Newcastle Town Centre", country: "GB" },
      },
      details: { capacityTotal: 200 },
    });
    // A dynamic record of no known site is dropped.
    expect(readings(out, "CP-EMPTY")).toEqual({});
  });
});

describe("utmc skips", () => {
  beforeEach(() => __resetSkips());

  const sites = () => [fixture("utmc-static-sample.json")];

  test("UTMC: a dynamic record of a car park the static feed lacks has no site", () => {
    // CP3-NO-DEF is skipped already as a static record.
    parse(sites(), [json([dynamic("CP9", 10, "SPACES"), dynamic("CP3-NO-DEF", 10, "SPACES")])]);
    expect(drainSkipped(utmcFeed().id)).toEqual({ no_geometry: 2 });
  });

  test("UTMC: a state or time it cannot read is an unknown value", () => {
    const out = parse(sites(), [
      json([
        dynamic("CP1", 10, "MAINTENANCE"),
        { systemCodeNumber: "CP2", dynamics: [{ occupancy: 5, lastUpdated: "later" }] },
      ]),
    ]);
    expect(readings(out, "CP1")).not.toHaveProperty("parking.status");
    const cp2 = out.observations.find((o) =>
      (o["subject"] as { featureId: string }).featureId.endsWith(":CP2"),
    );
    expect(cp2?.["phenomenonTime"]).toEqual({ instant: FETCHED });
    expect(drainSkipped(utmcFeed().id)).toEqual({ no_geometry: 1, unknown_value: 2 });
  });

  test("UTMC: a record without an id or with a coordinate that is no number is malformed", () => {
    const out = parse(
      [
        json([
          { definitions: [{ point: { latitude: 54.9, longitude: -1.6 } }] },
          {
            systemCodeNumber: "CPX",
            definitions: [{ point: { latitude: "54.9", longitude: -1.6 } }],
          },
        ]),
      ],
      [json([{ dynamics: [{ occupancy: 1 }] }])],
    );
    expect(out.features).toEqual([]);
    expect(drainSkipped(utmcFeed().id)).toEqual({ malformed: 3 });
  });
});
