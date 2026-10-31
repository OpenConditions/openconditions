import { __resetSkips, drainSkipped, type RecordDraft } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, it } from "vitest";
import { cbpOpeningHours, parseCbp } from "../formats/cbp.js";
import { cbpFeed, fixture, parseContext } from "./helpers/border-feed.js";
import { sealFailures } from "./helpers/seal.js";

/** The live capture's fetch; CBP wrote the page at 23:33:33Z. */
const FETCHED = "2026-10-14T23:38:05Z";
const PAGE = "2026-10-14T23:33:33Z";

const parse = (payload: Buffer | string, fetchedAt = FETCHED) =>
  parseCbp(
    cbpFeed(),
    { main: [typeof payload === "string" ? Buffer.from(payload) : payload] },
    parseContext(fetchedAt),
  );

const live = () => parse(fixture("cbp-bwtnew.json"));

type Subject = { featureId: string; componentKey?: string };
const subjectOf = (o: RecordDraft) => o["subject"] as Subject;

/** The readings of one port, by queue (`open` for the port's own status). */
function readings(observations: readonly RecordDraft[], port: string) {
  return Object.fromEntries(
    observations
      .filter((o) => subjectOf(o).featureId.endsWith(`:${port}`))
      .map((o) => {
        const result = o["result"] as { value: unknown };
        return [
          subjectOf(o).componentKey ?? "open",
          { value: result.value, at: (o["phenomenonTime"] as { instant: string }).instant },
        ];
      }),
  );
}

const featureOf = (features: readonly RecordDraft[], port: string) =>
  features.find((f) => (f["id"] as string).endsWith(`:${port}`))!;

/** One port record, every queue N/A unless given. */
function port(
  fields: Record<string, unknown>,
  lanes: Record<string, Record<string, unknown>> = {},
) {
  const na = { update_time: "", operational_status: "N/A", delay_minutes: "", lanes_open: "" };
  const group = (max: string, names: string[], prefix: string) =>
    Object.fromEntries([
      ["maximum_lanes", max],
      ...names.map((n) => [n, { ...na, ...lanes[`${prefix}.${n}`] }]),
    ]);
  return {
    port_number: "070801",
    border: "Canadian Border",
    port_name: "Alexandria Bay",
    crossing_name: "Thousand Islands Bridge",
    hours: "24 hrs/day",
    date: "10/14/2026",
    time: "19:33:33",
    port_status: "Open",
    commercial_vehicle_lanes: group("5", ["standard_lanes", "FAST_lanes"], "commercial"),
    passenger_vehicle_lanes: group(
      "8",
      ["standard_lanes", "NEXUS_SENTRI_lanes", "ready_lanes"],
      "passenger",
    ),
    pedestrian_lanes: group("N/A", ["standard_lanes", "ready_lanes"], "pedestrian"),
    construction_notice: "",
    ...fields,
  };
}

describe("parseCbp", () => {
  beforeEach(() => __resetSkips());

  it("seals every port it places, and leaves out El Paso without a crossing, which states no queue", () => {
    const out = live();
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    expect(out.features).toHaveLength(10);
    expect(out.rejected ?? 0).toBe(0);
    expect(drainSkipped(cbpFeed().id)).toEqual({});
    expect(out.features.some((f) => (f["id"] as string).endsWith(":240221"))).toBe(false);
  });

  it("counts a port entry that is no object as malformed instead of failing the poll", () => {
    const ports = JSON.parse(fixture("cbp-bwtnew.json").toString("utf8")) as unknown[];
    const out = parse(JSON.stringify([null, 7, ...ports]));
    expect(out.features).toHaveLength(10);
    expect(drainSkipped(cbpFeed().id)).toEqual({ malformed: 2 });
  });

  it("skips a port the crossing table lacks as unplaced once it states a queue", () => {
    const pending = { operational_status: "Update Pending" };
    const unknownPort = (lanes: Record<string, Record<string, unknown>>) =>
      port({ port_number: "240221", port_name: "El Paso", crossing_name: "" }, lanes);
    const out = parse(
      JSON.stringify([
        unknownPort({ "commercial.standard_lanes": pending, "passenger.standard_lanes": pending }),
        unknownPort({
          "passenger.standard_lanes": {
            operational_status: "delay",
            update_time: "At 4:00 pm MDT",
            delay_minutes: "25",
            lanes_open: "6",
          },
        }),
        unknownPort({
          "passenger.standard_lanes": { operational_status: "Temporarily suspended" },
        }),
      ]),
    );
    expect(out.features).toEqual([]);
    expect(out.observations).toEqual([]);
    expect(out.rejected ?? 0).toBe(0);
    expect(drainSkipped(cbpFeed().id)).toEqual({ no_geometry: 2 });
  });

  it("places a port at its crossing, with the port number and the crossing's Wikidata item", () => {
    const alexandria = featureOf(live().features, "070801");
    expect(alexandria).toMatchObject({
      id: "oc:feature:us-cbp-waits:070801",
      name: [{ lang: "en", text: "Alexandria Bay: Thousand Islands Bridge" }],
      location: {
        geometry: { type: "Point", coordinates: [-75.9834, 44.34732] },
        // CBP states no position; the crossing's Wikidata coordinate stands in for it.
        geometryOrigin: "derived",
        admin: { country: "US" },
      },
      externalIds: [
        { scheme: "cbp:port", id: "070801", authority: "CBP" },
        { scheme: "wikidata", id: "Q24191180" },
      ],
      openingHours: { osm: "24/7", twentyFourSeven: true, timezone: "America/New_York" },
      details: {
        countries: ["CA", "US"],
        ports: [
          {
            country: "US",
            name: [{ lang: "en", text: "Alexandria Bay: Thousand Islands Bridge" }],
            externalIds: [{ scheme: "cbp:port", id: "070801" }],
          },
        ],
        modes: ["commercial", "passenger"],
      },
    });
    expect(featureOf(live().features, "l24501")["id"]).toBe("oc:feature:us-cbp-waits:l24501");
  });

  it("gives a queue CBP marks N/A no lane group, and points every queue into the U.S.", () => {
    const alexandria = featureOf(live().features, "070801");
    const lanes = alexandria["components"] as { key: string; details: Record<string, unknown> }[];
    expect(lanes.map((c) => c.key)).toEqual([
      "commercial/standard",
      "passenger/standard",
      "passenger/trusted_traveller",
    ]);
    expect(lanes[2]!.details).toEqual({
      kind: "lane_group",
      v: 1,
      mode: "passenger",
      program: "trusted_traveller",
      direction: { from: "CA", to: "US" },
    });
    const douglas = featureOf(live().features, "260101");
    expect(
      (douglas["components"] as { details: { direction: unknown } }[]).every(
        (c) => JSON.stringify(c.details.direction) === '{"from":"MX","to":"US"}',
      ),
    ).toBe(true);
  });

  it("keeps the minutes and open lanes CBP states, a few minutes under no delay included", () => {
    const peace = readings(live().observations, "090101");
    expect(peace["commercial/standard"]).toEqual({
      value: { v: 1, status: "no_delay", waitMinutes: 6, lanesOpen: 4 },
      at: "2026-10-14T23:27:00Z",
    });
    expect(readings(live().observations, "260101")["passenger/standard"]?.value).toEqual({
      v: 1,
      status: "delay",
      waitMinutes: 60,
      lanesOpen: 4,
    });
  });

  it("reads closed and pending queues without minutes, dated by the page", () => {
    const alexandria = readings(live().observations, "070801");
    expect(alexandria["passenger/trusted_traveller"]).toEqual({
      value: { v: 1, status: "closed" },
      at: PAGE,
    });
    const pointRoberts = readings(live().observations, "300403");
    expect(Object.keys(pointRoberts)).toHaveLength(8);
    expect(pointRoberts["pedestrian/ready_lane"]).toEqual({
      value: { v: 1, status: "unknown" },
      at: PAGE,
    });
  });

  it("reads the port's status as the crossing's open status", () => {
    expect(readings(live().observations, "011502")["open"]).toEqual({ value: "closed", at: PAGE });
    expect(readings(live().observations, "070801")["open"]).toEqual({ value: "open", at: PAGE });
    expect(featureOf(live().features, "011502")["openingHours"]).toEqual({
      osm: "08:00-16:00",
      timezone: "America/New_York",
    });
  });

  it("dates a queue by the port's zone, not by the label it prints", () => {
    // Port Huron says EST in October, Douglas (Arizona) says PST.
    expect(readings(live().observations, "380201")["commercial/standard"]?.at).toBe(
      "2026-10-14T23:00:00Z",
    );
    expect(readings(live().observations, "260101")["passenger/standard"]?.at).toBe(
      "2026-10-14T23:00:00Z",
    );
  });

  it("reads a port whose clock runs an hour ahead of its zone by that clock", () => {
    // San Luis and Nogales print 17:33 at 16:33 MST: "At 5:00 pm" is 16:00 MST.
    expect(readings(live().observations, "260802")["commercial/standard"]?.at).toBe(
      "2026-10-14T23:00:00Z",
    );
    expect(readings(live().observations, "260402")["commercial/standard"]?.at).toBe(
      "2026-10-14T22:00:00Z",
    );
  });

  it("dates Arizona's queues in winter, when Phoenix keeps MST and the Pacific clock falls an hour behind", () => {
    // 2027-01-15 23:33:33Z: 18:33:33 EST, 16:33:33 MST in Phoenix, 15:33:33 PST.
    const wait = (at: string) => ({
      operational_status: "delay",
      update_time: at,
      delay_minutes: "15",
      lanes_open: "4",
    });
    const out = parse(
      JSON.stringify([
        port({ date: "1/15/2027", time: "18:33:33" }),
        port(
          { port_number: "260101", port_name: "Douglas", date: "1/15/2027", time: "16:33:33" },
          { "passenger.standard_lanes": wait("At 4:00 pm PST") },
        ),
        port(
          { port_number: "260401", port_name: "Nogales", date: "1/15/2027", time: "16:33:33" },
          { "passenger.standard_lanes": wait("At 4:00 pm MST") },
        ),
        port(
          { port_number: "260802", port_name: "San Luis", date: "1/15/2027", time: "15:33:33" },
          { "passenger.standard_lanes": wait("At 3:00 pm PST") },
        ),
      ]),
      "2027-01-15T23:38:05Z",
    );
    expect(readings(out.observations, "260101")["passenger/standard"]?.at).toBe(
      "2027-01-15T23:00:00Z",
    );
    expect(readings(out.observations, "260401")["passenger/standard"]?.at).toBe(
      "2027-01-15T23:00:00Z",
    );
    // A port on the Pacific clock is an hour behind Phoenix in winter: 3 pm there is 23:00Z.
    expect(readings(out.observations, "260802")["passenger/standard"]?.at).toBe(
      "2027-01-15T23:00:00Z",
    );
    expect(readings(out.observations, "260101")["open"]?.at).toBe("2027-01-15T23:33:33Z");
  });

  it("reads a queue time later than the fetch as yesterday's", () => {
    // "At 9:00 pm EDT" at 19:38 EDT.
    expect(readings(live().observations, "070801")["commercial/standard"]?.at).toBe(
      "2026-10-14T01:00:00Z",
    );
  });

  it("reads a time just past the fetch as the fetch, and midnight as the day's start", () => {
    const out = parse(
      JSON.stringify([
        port(
          {},
          {
            "commercial.standard_lanes": {
              operational_status: "delay",
              update_time: "At 7:45 pm EDT",
              delay_minutes: "20",
              lanes_open: "2",
            },
            "passenger.standard_lanes": {
              operational_status: "no delay",
              update_time: "At Midnight EDT",
              delay_minutes: "0",
              lanes_open: "1",
            },
          },
        ),
      ]),
    );
    const waits = readings(out.observations, "070801");
    expect(waits["commercial/standard"]?.at).toBe(FETCHED);
    expect(waits["passenger/standard"]?.at).toBe("2026-10-14T04:00:00Z");
  });

  it("dates a wait without an update time by the page, and an unknown state as unknown", () => {
    const out = parse(
      JSON.stringify([
        port(
          {},
          {
            "commercial.standard_lanes": {
              operational_status: "delay",
              delay_minutes: "",
              lanes_open: "3",
            },
            "passenger.standard_lanes": { operational_status: "Temporarily suspended" },
          },
        ),
      ]),
    );
    const waits = readings(out.observations, "070801");
    expect(waits["commercial/standard"]).toEqual({
      value: { v: 1, status: "delay", lanesOpen: 3 },
      at: PAGE,
    });
    expect(waits["passenger/standard"]?.value).toEqual({ v: 1, status: "unknown" });
    expect(drainSkipped(cbpFeed().id)).toEqual({ unknown_value: 1 });
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  it("keeps a port whose every queue is N/A by the modes it has lanes for, and skips one with none", () => {
    const out = parse(
      JSON.stringify([
        port({}),
        port({
          port_number: "011502",
          commercial_vehicle_lanes: { maximum_lanes: "N/A" },
          passenger_vehicle_lanes: { maximum_lanes: "N/A" },
          pedestrian_lanes: { maximum_lanes: "N/A" },
        }),
      ]),
    );
    expect(out.features).toHaveLength(1);
    expect(out.features[0]!["components"]).toBeUndefined();
    expect(out.features[0]!["details"]).toMatchObject({ modes: ["commercial", "passenger"] });
    expect(out.rejected ?? 0).toBe(0);
    expect(drainSkipped(cbpFeed().id)).toEqual({ malformed: 1 });
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  it("gives a mode's lanes in all to its queue where it has only one", () => {
    const out = live();
    const lanes = (id: string) =>
      Object.fromEntries(
        (featureOf(out.features, id)["components"] as { key: string; details: object }[]).map(
          (c) => [c.key, (c.details as { lanesTotal?: number }).lanesTotal],
        ),
      );
    // Alexandria Bay: commercial standard alone of 5 lanes; passengers queue in two of 8.
    expect(lanes("070801")).toEqual({
      "commercial/standard": 5,
      "passenger/standard": undefined,
      "passenger/trusted_traveller": undefined,
    });
  });

  it("reads the port's notice as its description, and counts hours it cannot read", () => {
    const out = parse(
      JSON.stringify([
        port({
          // As 230201 Hidalgo wrote it on 2026-10-17.
          construction_notice:
            "Ready Lane is open from 6AM until MIDNIGHT seven days a week.  Ready Lane is on the far left as you approach.\r\n\r\nGo to www.GetYouHome.gov for more information.",
          hours: "Seasonal",
        }),
      ]),
    );
    const alexandria = featureOf(out.features, "070801");
    expect(alexandria["description"]).toEqual([
      {
        lang: "en",
        text: "Ready Lane is open from 6AM until MIDNIGHT seven days a week. Ready Lane is on the far left as you approach. Go to www.GetYouHome.gov for more information.",
      },
    ]);
    expect(alexandria).not.toHaveProperty("openingHours");
    expect(drainSkipped(cbpFeed().id)).toEqual({ unknown_value: 1 });
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
  });

  it("reads CBP's Spanish edition the same way", () => {
    const out = parse(fixture("cbp-bwtnew-es.json"), "2026-06-26T21:06:20Z");
    expect(sealFailures([...out.features, ...out.observations])).toEqual([]);
    const alexandria = readings(out.observations, "070801");
    expect(alexandria["open"]?.value).toBe("open");
    expect(alexandria["commercial/standard"]?.value).toEqual({
      v: 1,
      status: "no_delay",
      waitMinutes: 0,
      lanesOpen: 1,
    });
    expect(alexandria["passenger/trusted_traveller"]?.value).toEqual({ v: 1, status: "closed" });
    expect(featureOf(out.features, "070801")["openingHours"]).toMatchObject({ osm: "24/7" });
    expect(readings(out.observations, "260401")["passenger/standard"]?.value).toMatchObject({
      status: "delay",
      waitMinutes: 45,
    });
  });

  it("fails on an answer that is not a list of ports", () => {
    expect(() => parse('{"error":"maintenance"}')).toThrow(/not a list of ports/);
  });
});

describe("cbpOpeningHours", () => {
  it("reads CBP's hours in both languages, and leaves anything else out", () => {
    const zone = "America/Chicago";
    expect(cbpOpeningHours("6 am-10 pm", zone)).toEqual({ osm: "06:00-22:00", timezone: zone });
    expect(cbpOpeningHours("8 am-Midnight", zone)).toEqual({ osm: "08:00-24:00", timezone: zone });
    expect(cbpOpeningHours("6 am-Medianoche", zone)).toEqual({
      osm: "06:00-24:00",
      timezone: zone,
    });
    expect(cbpOpeningHours("24 Hrs/Día", zone)).toMatchObject({ osm: "24/7" });
    expect(cbpOpeningHours("Seasonal", zone)).toBeUndefined();
    expect(cbpOpeningHours(undefined, zone)).toBeUndefined();
  });
});
