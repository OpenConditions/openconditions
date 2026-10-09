import {
  createFetchState,
  type FeedPayloads,
  fetchEndpoint,
  type ParseOutput,
  type RecordDraft,
} from "@openconditions/ingest-framework";
import { afterEach, describe, expect, test, vi } from "vitest";
import { hazardsDomain } from "../domain.js";
import { readNwsAlerts } from "../formats/nws.js";
import { fixture, nwsFeed, parseContext } from "./helpers/hazards-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-08T21:10:00Z";
const nws = hazardsDomain.formats["nws"]!;
const feed = nwsFeed();
const parse = (payloads: FeedPayloads, at = FETCHED): ParseOutput =>
  nws.parse(feed, payloads, parseContext(at, 120));

const ZONES = [
  "nws-zone-forecast-FLZ019.json",
  "nws-zone-county-FLC079.json",
  "nws-zone-forecast-PKZ662.json",
  "nws-zone-fire-AKZ801-404.json",
];
const zones = () => ZONES.map(fixture);

interface Feature {
  properties: Record<string, unknown>;
  geometry: unknown;
}
interface Collection {
  features: Feature[];
}
const collection = (): Collection =>
  JSON.parse(fixture("nws-alerts-active.json").toString("utf8")) as Collection;
const buffer = (c: unknown) => Buffer.from(JSON.stringify(c));
const feature = (c: Collection, event: string, messageType = "Alert") =>
  c.features.find(
    (f) => f.properties["event"] === event && f.properties["messageType"] === messageType,
  )!;

const byId = (out: ParseOutput, part: string) =>
  out.situations.find((s) => String(s["id"]).includes(part)) as RecordDraft;
const locationOf = (s: RecordDraft) =>
  s["location"] as {
    geometry: { type: string; coordinates: number[][][] | number[][][][] } | null;
    geometryOrigin: string;
    extent: string;
    admin?: { country: string; geocodes: { scheme: string; code: string }[] };
  };
const kind = (s: RecordDraft) => [s["type"], s["subtype"]].filter(Boolean).join(".");
const zoneRing = (name: string) =>
  (JSON.parse(fixture(name).toString("utf8")) as { geometry: { coordinates: number[][][] } })
    .geometry.coordinates[0]!;

describe("the nws format over the captured snapshot", () => {
  const out = parse({ alerts: [fixture("nws-alerts-active.json")], zones: zones() });

  test("every alert is classified by its VTEC phenomenon, or by its NWS product code", () => {
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations.map(kind)).toEqual([
      "flood.flash",
      "flood.river",
      "flood",
      "marine.small_craft",
      "air_quality",
    ]);
    const warning = byId(out, "eb661929f4f0d9d23699668a.001.1");
    expect(warning).toMatchObject({ kind: "alert", temporality: "live" });
    const cap = (warning["details"] as { cap: Record<string, unknown> }).cap;
    expect(cap["parameters"]).toContainEqual({
      valueName: "VTEC",
      value: expect.stringMatching(/^\/O\.NEW\.PHFO\.FF\.W\./),
    });
    expect(cap["eventCodes"]).toEqual([
      { valueName: "SAME", value: "FFW" },
      { valueName: "NationalWeatherService", value: "FFW" },
    ]);
  });

  test("a polygon alert keeps its own shape as the source's", () => {
    const warning = locationOf(byId(out, "eb661929f4f0d9d23699668a.001.1"));
    expect(warning).toMatchObject({ extent: "area", geometryOrigin: "source" });
    expect(warning.geometry?.type).toBe("Polygon");
    expect(warning.admin).toEqual({
      country: "US",
      geocodes: [
        { scheme: "same", code: "015003" },
        { scheme: "ugc", code: "HIC003" },
      ],
    });
  });

  test("a zone-only alert is placed at its zone's shape, derived", () => {
    const marine = locationOf(byId(out, "58efb8d5eadaa26c8c504963d5795835caecf788.004.1"));
    expect(marine).toMatchObject({ geometryOrigin: "derived", extent: "area" });
    expect(marine.geometry?.type).toBe("Polygon");
    const ring = (marine.geometry!.coordinates as number[][][])[0]!;
    expect(ring[0]).toEqual(zoneRing("nws-zone-forecast-PKZ662.json")[0]);
  });

  test("an alert whose zones have no shape keeps its geocodes and no geometry", () => {
    const aqa = byId(out, "8c84ea8eb3b6eabb337ba839a0526eeac1b8115b.001.1");
    expect(kind(aqa)).toBe("air_quality");
    expect(locationOf(aqa)).toMatchObject({
      geometry: null,
      geometryOrigin: "none",
      admin: {
        country: "US",
        geocodes: [
          { scheme: "same", code: "004013" },
          { scheme: "ugc", code: "AZC013" },
        ],
      },
    });
  });

  test("the stray Test message is terminal; every other alert counts once", () => {
    expect(out.records).toMatchObject({
      inputCount: 6,
      uniqueCount: 6,
      accepted: 5,
      terminal: 1,
      duplicates: 0,
    });
    expect(Object.keys(out.records!.situationRecords)).toHaveLength(5);
    expect(out.rejected).toBeUndefined();
  });

  test("the source link is the alert's CAP web verbatim; the alert text is kept whole", () => {
    const [warning] = out.situations as [RecordDraft];
    expect((warning["details"] as { cap: { web: string; senderName: unknown } }).cap.web).toBe(
      "http://www.weather.gov",
    );
    expect(warning["description"]).toEqual([
      { lang: "en-US", text: expect.stringContaining("\n") },
    ]);
  });
});

describe("the nws format: in force until the hazard ends", () => {
  // The flood watch's CAP `expires` (09:15Z) is its next issuance; NWS's `ends` (Oct 11 00:00Z) is the hazard's end.
  const AFTER_EXPIRES = "2026-10-09T12:00:00Z";

  test("an alert past its CAP expires but before its ends stays active and published", () => {
    const out = parse(
      { alerts: [fixture("nws-alerts-active.json")], zones: zones() },
      AFTER_EXPIRES,
    );
    expect(byId(out, "a273c7190a0a5a2d8a5c453d4cdae9049a16ae28.001.1")).toMatchObject({
      validity: { status: "active", end: "2026-10-10T20:00:00-04:00" },
      freshness: { expiresAt: "2026-10-10T20:00:00-04:00" },
      details: { cap: { expires: "2026-10-09T05:15:00-04:00" } },
    });
    // The small craft advisory (ends Oct 10 02:00Z) stays too; the flood warning and air quality alert, with no ends, leave.
    expect(out.situations.map(kind).sort()).toEqual(["flood", "marine.small_craft"]);
  });

  test("an alert past its CAP expires with no ends is terminal", () => {
    const c = collection();
    const f = feature(c, "Flood Watch");
    f.properties["ends"] = null;
    const out = parse({ alerts: [buffer({ ...c, features: [f] })] }, AFTER_EXPIRES);
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 1, terminal: 1 });
  });

  test("an ends earlier than expires leaves expires in charge", () => {
    const c = collection();
    const f = feature(c, "Flood Watch");
    f.properties["ends"] = "2026-10-09T01:00:00-04:00";
    const out = parse({ alerts: [buffer({ ...c, features: [f] })] });
    expect(out.situations[0]).toMatchObject({
      validity: { end: "2026-10-09T05:15:00-04:00" },
      freshness: { expiresAt: "2026-10-09T05:15:00-04:00" },
    });
  });
});

describe("the nws format: updates", () => {
  /** The real Update of the capture, with the message it replaces added as a sibling (constructed). */
  function withPredecessor() {
    const c = collection();
    const update = feature(c, "Flood Warning", "Update");
    const refs = update.properties["references"] as { identifier: string; sent: string }[];
    const predecessor = structuredClone(update);
    predecessor.properties["id"] = refs[0]!.identifier;
    predecessor.properties["@id"] = `https://api.weather.gov/alerts/${refs[0]!.identifier}`;
    predecessor.properties["messageType"] = "Alert";
    predecessor.properties["references"] = [];
    predecessor.properties["sent"] = refs[0]!.sent;
    c.features.push(predecessor);
    return { c, update, predecessor };
  }

  test("an Update and the message it replaces are one situation: the update, grouped under the original", () => {
    const { c, update, predecessor } = withPredecessor();
    const out = parse({ alerts: [buffer(c)] });
    const id = update.properties["id"] as string;
    const live = out.situations.filter((s) => String(s["id"]).includes(id));
    expect(live).toHaveLength(1);
    expect(
      out.situations.some((s) => String(s["id"]).includes(String(predecessor.properties["id"]))),
    ).toBe(false);
    expect(live[0]).toMatchObject({
      groupId: predecessor.properties["id"],
      relations: [
        {
          relation: "update_of",
          ref: {
            class: "situation",
            id: `oc:situation:us-nws-alerts:${String(predecessor.properties["id"])}`,
          },
        },
      ],
    });
    expect(out.records).toMatchObject({ inputCount: 7, terminal: 2, accepted: 5 });
  });

  test("an Update whose predecessor has left the snapshot stands alone and still names its warning", () => {
    const out = parse({ alerts: [fixture("nws-alerts-active.json")] });
    const c = collection();
    const update = feature(c, "Flood Warning", "Update");
    const two = parse({ alerts: [buffer({ ...c, features: [update] })] });
    expect(two.situations).toHaveLength(1);
    const refs = update.properties["references"] as { identifier: string }[];
    expect(two.situations[0]!["groupId"]).toBe(refs[0]!.identifier);
    expect(out.situations).toHaveLength(5);
  });
});

describe("the nws format: zone shapes", () => {
  /** The real flood watch, its zones cut to a forecast zone and a county zone (constructed). */
  function watch() {
    const c = collection();
    const f = feature(c, "Flood Watch");
    f.properties["affectedZones"] = [
      "https://api.weather.gov/zones/forecast/FLZ019",
      "https://api.weather.gov/zones/county/FLC079",
    ];
    return { c: { ...c, features: [f] }, f };
  }
  const place = (c: unknown, zonePayloads: Buffer[]) => {
    const out = parse({ alerts: [buffer(c)], zones: zonePayloads });
    return { out, location: locationOf(out.situations[0]!) };
  };

  test("a watch with a forecast zone and a county zone is the two shapes, derived", () => {
    const { c } = watch();
    const { out, location } = place(c, zones());
    expect(sealFailures(out.situations)).toEqual([]);
    expect(location.geometryOrigin).toBe("derived");
    expect(location.geometry!.type).toBe("MultiPolygon");
    const polygons = location.geometry!.coordinates as number[][][][];
    expect(polygons).toHaveLength(2);
    expect(polygons[0]![0]![0]).toEqual(zoneRing("nws-zone-forecast-FLZ019.json")[0]);
    expect(polygons[1]![0]![0]).toEqual(zoneRing("nws-zone-county-FLC079.json")[0]);
  });

  test("with the county zone missing it holds the forecast zone only", () => {
    const { c } = watch();
    const { location } = place(c, [fixture("nws-zone-forecast-FLZ019.json")]);
    expect(location.geometryOrigin).toBe("derived");
    expect(location.geometry!.type).toBe("Polygon");
  });

  test("a zone that answered 404 contributes nothing and does not fail the poll", () => {
    const { c } = watch();
    const missing = place(c, [fixture("nws-zone-fire-AKZ801-404.json")]);
    expect(missing.location.geometry).toBeNull();
    const mixed = place(c, [
      fixture("nws-zone-fire-AKZ801-404.json"),
      fixture("nws-zone-forecast-FLZ019.json"),
    ]);
    expect(mixed.location.geometry!.type).toBe("Polygon");
  });

  test("with no zone shape at all the alert has no geometry and its ugc and same geocodes", () => {
    const { c } = watch();
    const { out, location } = place(c, []);
    expect(out.situations).toHaveLength(1);
    expect(location).toMatchObject({
      geometry: null,
      geometryOrigin: "none",
      admin: { country: "US" },
    });
    expect(location.admin!.geocodes.map((g) => g.scheme)).toContain("ugc");
    expect(location.admin!.geocodes.map((g) => g.scheme)).toContain("same");
    expect(parse({ alerts: [buffer(c)] }).situations).toHaveLength(1);
  });

  /** A zone payload as the zones API serves it: `key` is `<type>/<id>`. */
  const zoneOf = (key: string, geometry: unknown) =>
    Buffer.from(
      JSON.stringify({
        type: "Feature",
        geometry,
        properties: {
          "@id": `https://api.weather.gov/zones/${key}`,
          id: key.split("/")[1],
        },
      }),
    );
  const square = (x: number) => ({
    type: "Polygon",
    coordinates: [
      [
        [x, 30],
        [x, 31],
        [x + 1, 31],
        [x + 1, 30],
        [x, 30],
      ],
    ],
  });

  test("fire and forecast zones that share an id are told apart by type", () => {
    const c = collection();
    const f = feature(c, "Flood Watch");
    f.properties["affectedZones"] = ["https://api.weather.gov/zones/fire/XXZ001"];
    const payloads = [zoneOf("forecast/XXZ001", square(-90)), zoneOf("fire/XXZ001", square(-80))];
    for (const order of [payloads, [...payloads].reverse()]) {
      const { location } = place({ ...c, features: [f] }, order);
      expect(location.geometry!.type).toBe("Polygon");
      expect((location.geometry!.coordinates as number[][][])[0]![0]).toEqual([-80, 30]);
    }
  });

  test("a zone shape with a position out of range is skipped; the alert keeps its geocodes", () => {
    const { c } = watch();
    const ring = [
      [-84, 30],
      [-84, 31],
      [200, 31],
      [-84, 30],
    ];
    const { location } = place(c, [
      zoneOf("forecast/FLZ019", { type: "Polygon", coordinates: [ring] }),
    ]);
    expect(location.geometry).toBeNull();
    expect(location.admin!.geocodes.length).toBeGreaterThan(0);
  });

  test("a zone shape that is no polygon is skipped", () => {
    const { c } = watch();
    const { location } = place(c, [
      zoneOf("forecast/FLZ019", { type: "Point", coordinates: [-84, 30] }),
    ]);
    expect(location.geometry).toBeNull();
  });

  test("a zone shape is simplified once, to 0.005 degrees", () => {
    const { c } = watch();
    const ring = Array.from({ length: 721 }, (_, i) => {
      const a = (Math.min(i, 720) * Math.PI) / 360;
      return [-84 + 0.5 * Math.cos(a), 30 + 0.5 * Math.sin(a)];
    });
    const { location } = place(c, [
      zoneOf("forecast/FLZ019", { type: "Polygon", coordinates: [ring] }),
    ]);
    const kept = (location.geometry!.coordinates as number[][][])[0]!;
    expect(kept.length).toBeLessThan(80);
    expect(kept.length).toBeGreaterThan(8);
    expect(kept[0]).toEqual(kept.at(-1));
  });

  test("an alert with its own polygon ignores the zone shapes", () => {
    const c = collection();
    const f = feature(c, "Flash Flood Warning");
    f.properties["affectedZones"] = ["https://api.weather.gov/zones/forecast/FLZ019"];
    const { location } = place({ ...c, features: [f] }, zones());
    expect(location.geometryOrigin).toBe("source");
  });
});

describe("the nws format: records and errors", () => {
  test("GeoJSON-LD maps to CAP: singular fields as lists, name→values objects as ordered pairs", () => {
    const alerts = readNwsAlerts(fixture("nws-alerts-active.json"));
    expect(alerts).toHaveLength(6);
    const watch = alerts.find((a) => a.info![0]!.event === "Flood Watch")!;
    expect(watch).toMatchObject({
      sender: "w-nws.webmaster@noaa.gov",
      status: "Actual",
      msgType: "Alert",
      scope: "Public",
      code: ["IPAWSv1.0"],
    });
    const info = watch.info![0]!;
    expect(info).toMatchObject({
      language: "en-US",
      category: ["Met"],
      responseType: ["Prepare"],
      urgency: "Future",
      severity: "Severe",
      certainty: "Possible",
    });
    expect(info.parameter!.map((p) => p.valueName)).toEqual([
      "AWIPSidentifier",
      "WMOidentifier",
      "NWSheadline",
      "BLOCKCHANNEL",
      "BLOCKCHANNEL",
      "BLOCKCHANNEL",
      "EAS-ORG",
      "VTEC",
      "eventEndingTime",
    ]);
    expect(info.area![0]!.geocode!.slice(0, 2)).toEqual([
      { valueName: "SAME", value: "012079" },
      { valueName: "SAME", value: "012123" },
    ]);
  });

  test("references are CAP's sender,identifier,sent triples; a polygon is lat,lon pairs", () => {
    const alerts = readNwsAlerts(fixture("nws-alerts-active.json"));
    const update = alerts.find((a) => a.msgType === "Update")!;
    expect(update.references).toMatch(
      /^w-nws\.webmaster@noaa\.gov,urn:oid:2\.49\.0\.1\.840\.0\.[\w.]+,/,
    );
    const polygon = alerts.find((a) => a.info![0]!.event === "Flash Flood Warning")!;
    const first = collection().features.find((f) => f.geometry !== null)!.geometry as {
      coordinates: number[][][];
    };
    const [lon, lat] = first.coordinates[0]![0]!;
    expect(polygon.info![0]!.area![0]!.polygon![0]!.startsWith(`${lat},${lon} `)).toBe(true);
  });

  test("a polygon with a position out of range rejects that alert only", () => {
    const c = collection();
    const bad = feature(c, "Flash Flood Warning");
    (bad.geometry as { coordinates: number[][][] }).coordinates[0]![1] = [-157, 95];
    const out = parse({ alerts: [buffer(c)] });
    expect(out.situations).toHaveLength(4);
    expect(out.rejected).toBe(1);
    expect(out.records).toMatchObject({ inputCount: 6, accepted: 4, terminal: 1 });
  });

  test("a feature that is no alert is a rejected record; the others publish", () => {
    const c = collection();
    const out = parse({
      alerts: [buffer({ ...c, features: [...c.features, 3, { type: "Feature" }] })],
    });
    expect(out.situations).toHaveLength(5);
    expect(out.rejected).toBe(2);
  });

  test("a quiet poll is an accounted zero", () => {
    const out = parse({ alerts: [buffer({ type: "FeatureCollection", features: [] })] });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 0, accepted: 0, terminal: 0 });
  });

  test("a publisher error document fails the parse", () => {
    const problem = Buffer.from(
      JSON.stringify({ title: "Unexpected Problem", status: 500, detail: "try again" }),
    );
    expect(() => parse({ alerts: [problem] })).toThrow(/no alert collection: Unexpected Problem/);
    expect(() => parse({ alerts: [Buffer.from("<html>busy</html>")] })).toThrow();
  });

  test("a message that is not Actual is terminal", () => {
    const c = collection();
    const f = feature(c, "Flash Flood Warning");
    f.properties["status"] = "Exercise";
    const out = parse({ alerts: [buffer({ ...c, features: [f] })] });
    expect(out.situations).toEqual([]);
    expect(out.records).toMatchObject({ inputCount: 1, terminal: 1 });
  });
});

describe("the nws format over its endpoints", () => {
  afterEach(() => vi.restoreAllMocks());

  test("each affected zone is fetched once by its type and id; one that answers 404 does not fail the role", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const served = new Map<string, Uint8Array<ArrayBuffer>>([
      [
        "https://api.weather.gov/alerts/active?status=actual",
        new Uint8Array(fixture("nws-alerts-active.json")),
      ],
      ["https://api.weather.gov/zones/forecast/FLZ019", new Uint8Array(fixture(ZONES[0]!))],
      ["https://api.weather.gov/zones/forecast/PKZ662", new Uint8Array(fixture(ZONES[2]!))],
    ]);
    const requested: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      requested.push(String(input));
      const body = served.get(String(input));
      return body === undefined ? new Response("not found", { status: 404 }) : new Response(body);
    }) as never;
    const state = createFetchState();
    const at = Date.parse(FETCHED);
    const alerts = await fetchEndpoint(feed, "alerts", fetchFn, { state, at });
    if (alerts.status !== "fetched") throw new Error(`unexpected ${alerts.status}`);
    const fetchedZones = await fetchEndpoint(feed, "zones", fetchFn, {
      state,
      at,
      eachSource: alerts.buffers,
      eachSourceUrls: alerts.urls,
    });
    // Some zone URLs answer 404 in the stub: the role is partial, not failed.
    if (fetchedZones.status !== "partial") throw new Error(`unexpected ${fetchedZones.status}`);
    const zoneRequests = requested.filter((u) => u.includes("/zones/"));
    expect(new Set(zoneRequests).size).toBe(zoneRequests.length);
    expect(zoneRequests).toContain("https://api.weather.gov/zones/forecast/FLZ019");
    expect(zoneRequests).toContain("https://api.weather.gov/zones/forecast/PKZ662");
    const out = parse({ alerts: alerts.buffers, zones: fetchedZones.buffers });
    expect(sealFailures(out.situations)).toEqual([]);
    expect(out.situations).toHaveLength(5);
    expect(
      locationOf(byId(out, "a273c7190a0a5a2d8a5c453d4cdae9049a16ae28.001.1")).geometryOrigin,
    ).toBe("derived");
  });
});
