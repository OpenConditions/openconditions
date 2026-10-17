import {
  drainSkipped,
  type EgressRecord,
  isPublicRecord,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { parseParkApiV3 } from "../formats/parkapi-v3.js";
import { fixture, mobidataFeed, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-10-05T03:31:40Z";

function parse(main: Buffer, sources?: Buffer): ParseOutput {
  const out = parseParkApiV3(
    mobidataFeed(),
    { main: [main], ...(sources ? { sources: [sources] } : {}) },
    parseContext(FETCHED),
  );
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const both = () => parse(fixture("parkapi-v3-sites.json"), fixture("parkapi-v3-sources.json"));

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => f["id"] === `oc:feature:de-bw-mobidata-parking:${stationId}`);

function readings(out: ParseOutput, stationId: string): Record<string, unknown> {
  const featureId = site(out, stationId)?.["id"];
  return Object.fromEntries(
    out.observations
      .filter((o) => (o["subject"] as { featureId: string }).featureId === featureId)
      .map((o) => [o["property"], (o["result"] as { value: unknown }).value]),
  );
}

/** The fixture with its items replaced, for cases the capture holds no site of. */
function sitesWith(edit: (items: Record<string, unknown>[]) => Record<string, unknown>[]) {
  const doc = JSON.parse(fixture("parkapi-v3-sites.json").toString("utf8"));
  return Buffer.from(JSON.stringify({ ...doc, items: edit(doc.items) }));
}

describe("parkapi-v3", () => {
  test("ParkAPI v3: a Toll Collect site is truck parking with live counts", () => {
    const out = both();
    const aachen = site(out, "50294");
    expect(aachen).toMatchObject({
      type: "truck_parking",
      name: [{ lang: "de", text: "Aachener Land Süd" }],
      externalIds: [
        { scheme: "provider", id: "50294", authority: "de-bw-mobidata-parking/toll_collect" },
      ],
      components: [
        {
          key: "truck:any",
          details: {
            kind: "parking_area",
            v: 1,
            vehicleType: "truck",
            userGroup: "any",
            capacity: 90,
          },
        },
      ],
      details: { capacityTotal: 90, usage: ["truck"], layout: "surface" },
      access: { audience: "unknown", payment: ["free"] },
    });
    expect(readings(out, "50294")).toEqual({
      "parking.available": 0,
      "parking.status": "open",
    });
    const reading = out.observations.find(
      (o) => (o["subject"] as { featureId: string }).featureId === aachen?.["id"],
    );
    expect(reading?.["phenomenonTime"]).toEqual({ instant: "2026-10-05T03:28:48Z" });
  });

  test("ParkAPI v3: a Karlsruhe site credits Stadt Karlsruhe under CC-BY-4.0 as upstream", () => {
    const out = both();
    const karstadt = site(out, "19776");
    expect(karstadt).toMatchObject({
      type: "off_street",
      externalIds: [
        { scheme: "provider", id: "19776", authority: "de-bw-mobidata-parking/karlsruhe" },
      ],
      location: { address: { text: "Zähringerstraße 69, 76133 Karlsruhe", country: "DE" } },
      provenance: {
        sourceId: "de-bw-mobidata-parking",
        sourceFormat: "parkapi-v3",
        attribution: { license: "DL-DE-BY-2.0" },
        upstream: [{ publisher: "Stadt Karlsruhe", recordId: "66", license: "CC-BY-4.0" }],
      },
      details: { heightLimit: { value: 2, unit: "m" }, layout: "multi_storey" },
    });
    expect(readings(out, "19780")).toMatchObject({
      "parking.status": "closed",
    });
  });

  test.each(["CC BY 4.0", "ODbL-1.0"])(
    "captures %s upstream on every live reading and enforces public admission",
    (license) => {
      const doc = JSON.parse(fixture("parkapi-v3-sources.json").toString("utf8"));
      for (const source of doc.items)
        if (source.uid === "karlsruhe") source.attribution_license = license;
      const out = parse(fixture("parkapi-v3-sites.json"), Buffer.from(JSON.stringify(doc)));
      const feature = site(out, "19780")!;
      const selected = out.observations.filter(
        (o) => (o["subject"] as { featureId: string }).featureId === feature["id"],
      );
      expect(selected.length).toBeGreaterThan(0);
      for (const reading of selected) {
        expect((reading["provenance"] as Record<string, unknown>)["upstream"]).toEqual(
          (feature["provenance"] as Record<string, unknown>)["upstream"],
        );
        expect(isPublicRecord(reading as unknown as EgressRecord)).toBe(license !== "ODbL-1.0");
      }
    },
  );

  test("ParkAPI v3: a source without a contributor is credited by its name and licence text", () => {
    const out = both();
    expect(site(out, "16590")?.["provenance"]).toMatchObject({
      upstream: [
        { publisher: "Verband Region Stuttgart", recordId: "1445", license: "DL-DE-BY-2.0" },
      ],
    });
    expect(site(out, "43273")?.["provenance"]).toMatchObject({
      upstream: [{ publisher: "Ladenburg: Parkraumcheck", recordId: "3" }],
    });
    expect(site(out, "43273")).toMatchObject({ type: "on_street" });
  });

  test("ParkAPI v3: a free count is bounded by the live capacity", () => {
    const out = both();
    // 143 free of 147 live spaces, though the static capacity says 137.
    expect(readings(out, "16590")).toEqual({ "parking.available": 143 });
    expect(site(out, "16590")).toMatchObject({
      type: "park_and_ride",
      details: { capacityTotal: 137 },
    });
  });

  test("ParkAPI v3: free capacity above capacity is no reading", () => {
    const out = parse(
      sitesWith((items) => [
        // Above the live capacity, which wins over the static one.
        { ...items[3], id: 1, capacity: 200, realtime_capacity: 140, realtime_free_capacity: 143 },
        // Without a live capacity, the static one bounds it.
        { ...items[3], id: 2, capacity: 137, realtime_capacity: undefined },
        { ...items[3], id: 3, capacity: 150, realtime_capacity: undefined },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    expect(readings(out, "1")).toEqual({});
    expect(readings(out, "2")).toEqual({});
    expect(readings(out, "3")).toEqual({ "parking.available": 143 });
  });

  test("ParkAPI v3: a site's restrictions are areas with their hours, stays and live counts", () => {
    const out = parse(
      sitesWith((items) => [
        {
          ...items[3],
          id: 1,
          restrictions: [
            { type: "DISABLED", capacity: 11, realtime_capacity: 10, realtime_free_capacity: 4 },
            { type: "WOMEN", capacity: 5, max_stay: "PT2H" },
            // A count of none is no area.
            { type: "CHARGING", capacity: 0 },
            { type: "TAXI", capacity: 2 },
            // Every audience at some hours: the area of the site's own vehicles.
            { max_stay: "PT2H", hours: "Mo-Fr 08:00-18:00" },
            { type: "TRUCK", capacity: 3, realtime_free_capacity: 1 },
            // Above its capacity: no reading for the area.
            { type: "FAMILY", capacity: 2, realtime_free_capacity: 3 },
          ],
        },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    const feature = site(out, "1")!;
    expect(feature).toMatchObject({ type: "park_and_ride", details: { capacityTotal: 137 } });
    expect((feature["details"] as { usage?: string[]; maxStay?: unknown }).usage).not.toContain(
      "truck",
    );
    // The stay at some hours only is the area's, not the site's.
    expect((feature["details"] as { maxStay?: unknown }).maxStay).toBeUndefined();
    const components = feature["components"] as { key: string; details: Record<string, unknown> }[];
    expect(components.map((c) => [c.key, c.details["capacity"]])).toEqual([
      ["car:disabled", 11],
      ["car:women", 5],
      ["car:taxi", 2],
      ["car:any", undefined],
      ["truck:any", 3],
      ["car:family", 2],
    ]);
    expect(components[1]!.details).toMatchObject({ maxStay: { value: 120, unit: "min" } });
    expect(components[3]!.details).toMatchObject({
      hours: { osm: "Mo-Fr 08:00-18:00" },
      maxStay: { value: 120, unit: "min" },
    });
    const byArea = Object.fromEntries(
      out.observations
        .filter((o) => o["property"] === "parking.available")
        .map((o) => [
          (o["subject"] as { componentKey?: string }).componentKey ?? "site",
          (o["result"] as { value: unknown }).value,
        ]),
    );
    expect(byArea).toEqual({ site: 143, "car:disabled": 4, "truck:any": 1 });
  });

  test("ParkAPI v3: a site restricted to lorries as a whole is a lorry park, whatever its source", () => {
    const out = parse(
      sitesWith((items) => [
        // Esslingen restricts a car site to lorries the way Toll Collect does.
        { ...items[1], id: 1, capacity: 12, restrictions: [{ type: "TRUCK" }] },
        // A Toll Collect site without the restriction is no lorry park.
        { ...items[0], id: 2, restrictions: [] },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    expect(site(out, "1")).toMatchObject({
      type: "truck_parking",
      externalIds: [{ authority: "de-bw-mobidata-parking/karlsruhe" }],
      components: [{ key: "truck:any", details: { capacity: 12 } }],
      details: { usage: ["truck"] },
    });
    expect(site(out, "2")).toMatchObject({
      type: "off_street",
      externalIds: [{ authority: "de-bw-mobidata-parking/toll_collect" }],
    });
    expect(site(out, "2")?.["components"]).toBeUndefined();
  });

  test("ParkAPI v3: a poll without the source list is refused", () => {
    // Without it every site would go uncredited under the bare feed authority.
    expect(() =>
      parseParkApiV3(
        mobidataFeed(),
        { main: [fixture("parkapi-v3-sites.json")] },
        parseContext(FETCHED),
      ),
    ).toThrow(/sources/);
  });

  test("ParkAPI v3: only car sites and sites without a purpose are kept", () => {
    drainSkipped(mobidataFeed().id);
    const out = parse(
      sitesWith((items) => [
        { ...items[1], id: 1, purpose: "BIKE", type: "STANDS" },
        { ...items[1], id: 2, purpose: undefined },
        { ...items[1], id: 3, lat: null },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    expect(out.features.map((f) => f["id"])).toEqual(["oc:feature:de-bw-mobidata-parking:2"]);
    // The bicycle site is left out by design; the unplaceable one is skipped.
    expect(drainSkipped(mobidataFeed().id)).toEqual({ no_geometry: 1 });
  });

  const maxStay = (restrictions: unknown[], extra: Record<string, unknown> = {}) => {
    const out = parse(
      sitesWith((items) => [{ ...items[1], id: 1, restrictions, ...extra }]),
      fixture("parkapi-v3-sources.json"),
    );
    return (site(out, "1")?.["details"] as { maxStay?: unknown } | undefined)?.maxStay;
  };

  test("ParkAPI v3: a maximum stay for every audience at all hours is the site's", () => {
    expect(maxStay([{ max_stay: "PT2H" }])).toEqual({ value: 120, unit: "min" });
    expect(maxStay([{ max_stay: "P1DT30M" }])).toEqual({ value: 1470, unit: "min" });
    // Alternatives: any of them allows the longest.
    expect(maxStay([{ max_stay: "PT1H" }, { max_stay: "PT3H" }])).toEqual({
      value: 180,
      unit: "min",
    });
    // The deprecated site field, in seconds, when no restriction gives one.
    expect(maxStay([], { max_stay: 5400 })).toEqual({ value: 90, unit: "min" });
    expect(maxStay([{ max_stay: "PT4H" }], { max_stay: 5400 })).toEqual({
      value: 240,
      unit: "min",
    });
  });

  test("ParkAPI v3: a maximum stay for one audience, some hours or of no fixed length is not the site's", () => {
    expect(maxStay([{ type: "DISABLED", capacity: 3, max_stay: "PT2H" }])).toBeUndefined();
    expect(maxStay([{ max_stay: "PT2H", hours: "Mo-Fr 08:00-18:00" }])).toBeUndefined();
    expect(maxStay([{ capacity: 4, max_stay: "PT2H" }])).toBeUndefined();
    expect(maxStay([{ max_stay: "P1M" }])).toBeUndefined();
    expect(maxStay([{ max_stay: "PT" }])).toBeUndefined();
    expect(maxStay([{ max_stay: "2 hours" }])).toBeUndefined();
  });

  test("ParkAPI v3: supervision, lighting and a roof", () => {
    const out = parse(
      sitesWith((items) => [
        { ...items[1], id: 1, supervision_type: "ATTENDED", has_lighting: true },
        { ...items[1], id: 2, supervision_type: "VIDEO" },
        {
          ...items[1],
          id: 3,
          supervision_type: "NO",
          type: "OFF_STREET_PARKING_GROUND",
          is_covered: true,
        },
        // A garage is covered already.
        { ...items[1], id: 4, is_covered: true },
        // Supervised, without saying how.
        { ...items[1], id: 5, supervision_type: "YES" },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    expect(site(out, "1")?.["details"]).toMatchObject({
      supervision: "on_site",
      securityFeatures: ["lighting"],
    });
    expect(site(out, "2")?.["details"]).toMatchObject({ securityFeatures: ["cctv"] });
    expect(site(out, "2")?.["details"]).not.toHaveProperty("supervision");
    expect(site(out, "3")?.["details"]).toMatchObject({ supervision: "none", layout: "covered" });
    expect(site(out, "4")?.["details"]).toMatchObject({ layout: "multi_storey" });
    expect(site(out, "5")?.["details"]).toMatchObject({ supervision: "supervised" });
  });

  test("ParkAPI v3: a site restricted to customers as a whole is a customers' car park", () => {
    const out = parse(
      sitesWith((items) => [
        { ...items[1], id: 1, restrictions: [{ type: "CUSTOMER" }] },
        { ...items[1], id: 2, restrictions: [{ type: "CUSTOMER", capacity: 260 }] },
        // Part of a site: the customers' area, and the site stays everyone's.
        { ...items[1], id: 3, restrictions: [{ type: "CUSTOMER", capacity: 20 }] },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    for (const id of ["1", "2"]) {
      expect(site(out, id)).toMatchObject({
        access: { audience: "customers" },
        details: { usage: ["customer"] },
      });
    }
    expect(site(out, "3")).not.toHaveProperty("access");
    expect(site(out, "3")?.["components"]).toEqual([
      expect.objectContaining({
        key: "car:customers",
        details: expect.objectContaining({ capacity: 20 }),
      }),
    ]);
  });

  test("ParkAPI v3: a site's photo, limits, outline, bay layout, region and stops", () => {
    const line = {
      type: "LineString",
      coordinates: [
        [8.4, 49],
        [8.41, 49],
      ],
    };
    const out = parse(
      sitesWith((items) => [
        {
          ...items[4],
          id: 1,
          photo_url: "https://example.org/p.jpg",
          max_width: 230,
          capacity_min: 5,
          capacity_max: 9,
          orientation: "DIAGONAL",
          side: "LEFT",
          parking_type: "HALF_ON_KERB",
          linear_parking_position: "ROAD_CENTER_LINE",
          geojson: line,
          official_region_code: "082120000000",
          related_location: "Schule am Park",
          external_identifiers: [{ type: "DHID", value: "de:08212:1" }],
        },
        // An unclosed ring is no outline; an eight-digit municipality key is no regional key.
        {
          ...items[4],
          id: 2,
          geojson: {
            type: "Polygon",
            coordinates: [
              [
                [8.4, 49],
                [8.41, 49],
                [8.41, 49.01],
              ],
            ],
          },
          official_region_code: "08212000",
        },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    const feature = site(out, "1")!;
    expect(feature["images"]).toEqual([{ url: "https://example.org/p.jpg", category: "site" }]);
    expect(feature["location"]).toMatchObject({
      geometry: { type: "Point" },
      admin: { country: "DE", geocodes: [{ scheme: "ars", code: "082120000000" }] },
      areaDescription: [{ lang: "de", text: "Schule am Park" }],
    });
    expect(feature["details"]).toMatchObject({
      widthLimit: { value: 2.3, unit: "m" },
      capacityRange: { min: 5, max: 9 },
      bays: { orientation: "diagonal", side: "left", position: "half_on_kerb" },
      outline: { geometry: line, line: "road_centre" },
      stops: [{ scheme: "ifopt", id: "de:08212:1" }],
    });
    expect(site(out, "2")?.["details"]).not.toHaveProperty("outline");
    expect(site(out, "2")?.["location"]).not.toHaveProperty("admin.geocodes");
  });

  test("ParkAPI v3: a source's licence page goes with its credit", () => {
    const out = parse(
      sitesWith((items) => [
        { ...items[2], id: 1 },
        { ...items[0], id: 2 },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    const upstream = (id: string) =>
      (site(out, id)?.["provenance"] as { upstream: Record<string, unknown>[] } | undefined)
        ?.upstream[0];
    expect(upstream("1")).toMatchObject({
      publisher: "Stadt Karlsruhe",
      license: "CC-BY-4.0",
      licensing: {
        declarations: [{ text: "CC-BY-4.0", url: "http://creativecommons.org/licenses/by/4.0/" }],
        bindings: [
          {
            subject: "Stadt Karlsruhe",
            license: {
              kind: "spdx",
              expression: "CC-BY-4.0",
              url: "http://creativecommons.org/licenses/by/4.0/",
            },
          },
        ],
      },
    });
    // Without a licence page the publish step captures the licence alone, as before.
    expect(upstream("2")).not.toHaveProperty("licensing");
  });
  /** The spots capture, with its items edited. */
  function spotsWith(edit: (items: Record<string, unknown>[]) => Record<string, unknown>[]) {
    const doc = JSON.parse(fixture("parkapi-v3-spots.json").toString("utf8"));
    return Buffer.from(JSON.stringify({ ...doc, items: edit(doc.items) }));
  }

  const withSpots = (spots: Buffer) => {
    const out = parseParkApiV3(
      mobidataFeed(),
      {
        main: [fixture("parkapi-v3-sites.json")],
        sources: [fixture("parkapi-v3-sources.json")],
        spots: [spots],
      },
      parseContext(FETCHED),
    );
    expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
    return out;
  };

  test("ParkAPI v3: a bay of a kept site is its space, with its live state", () => {
    drainSkipped(mobidataFeed().id);
    const out = withSpots(
      spotsWith(([attached, live]) => [
        // Moved onto a captured site, with the live state of another bay.
        {
          ...attached,
          parking_site_id: 19776,
          realtime_status: "AVAILABLE",
          has_realtime_data: true,
          realtime_data_updated_at: "2026-10-05T03:20:00Z",
        },
        { ...live, parking_site_id: 19776, realtime_status: "UNKNOWN" },
      ]),
    );
    const karstadt = site(out, "19776");
    expect(karstadt?.["components"]).toEqual([
      {
        key: "spot:5661",
        kind: "parking_space",
        name: [{ lang: "de", text: "Parkplatz" }],
        position: { type: "Point", coordinates: [9.6581032, 49.6244416] },
        details: { kind: "parking_space", v: 1, vehicleType: "car", userGroup: "disabled" },
      },
      expect.objectContaining({ key: "spot:762" }),
    ]);
    const spaces = Object.fromEntries(
      out.observations
        .filter((o) =>
          (o["subject"] as { componentKey?: string }).componentKey?.startsWith("spot:"),
        )
        .map((o) => [
          `${(o["subject"] as { componentKey: string }).componentKey} ${o["property"]}`,
          (o["result"] as { value: unknown }).value,
        ]),
    );
    expect(spaces).toEqual({
      "spot:5661 parking.available": 1,
      "spot:762 parking.status": "unknown",
    });
    // No bay stands alone.
    expect(out.features.filter((f) => String(f["id"]).includes(":spot/"))).toEqual([]);
    expect(drainSkipped(mobidataFeed().id)).toEqual({});
  });

  test("ParkAPI v3: a bay of no kept site is a site of one space", () => {
    const out = withSpots(fixture("parkapi-v3-spots.json"));
    // Bay 5661's site 17760 is not in the trimmed capture.
    expect(site(out, "spot/5661")).toMatchObject({
      type: "off_street",
      details: { capacityTotal: 1, layout: "surface" },
      components: [{ key: "car:disabled" }],
    });
    expect(site(out, "spot/762")).toMatchObject({ type: "on_street" });
    expect(readings(out, "spot/762")).toEqual({ "parking.available": 0 });
    expect(site(out, "spot/141")?.["details"]).toMatchObject({
      outline: { geometry: { type: "Polygon" } },
    });
    expect(readings(out, "spot/141")).toEqual({});
  });

  test("ParkAPI v3: a bay is counted by why it is dropped, and a state ParkAPI does not define", () => {
    drainSkipped(mobidataFeed().id);
    withSpots(
      spotsWith(([attached, live, alone]) => [
        { ...attached, lat: null },
        { ...live, realtime_status: "BLOCKED" },
        { ...alone, purpose: "BIKE" },
        { ...alone, id: undefined },
      ]),
    );
    expect(drainSkipped(mobidataFeed().id)).toEqual({
      no_geometry: 1,
      malformed: 1,
      unknown_value: 1,
    });
  });
});
