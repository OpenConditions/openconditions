import {
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

  test("ParkAPI v3: a site's restrictions with their own spaces are areas with live counts", () => {
    const out = parse(
      sitesWith((items) => [
        {
          ...items[3],
          id: 1,
          restrictions: [
            { type: "DISABLED", capacity: 11, realtime_capacity: 10, realtime_free_capacity: 4 },
            { type: "WOMEN", capacity: 5, max_stay: "PT2H" },
            // A count of none is no area, and ParkAPI audiences without a user group are skipped.
            { type: "CHARGING", capacity: 0 },
            { type: "TAXI", capacity: 2 },
            // Applies to every audience: no area of its own.
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
    expect((feature["details"] as { usage?: string[] }).usage).not.toContain("truck");
    expect(
      (feature["components"] as { key: string; details: { capacity?: number } }[]).map((c) => [
        c.key,
        c.details.capacity,
      ]),
    ).toEqual([
      ["car:disabled", 11],
      ["car:women", 5],
      ["truck:any", 3],
      ["car:family", 2],
    ]);
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
    const out = parse(
      sitesWith((items) => [
        { ...items[1], id: 1, purpose: "BIKE", type: "STANDS" },
        { ...items[1], id: 2, purpose: undefined },
        { ...items[1], id: 3, lat: null },
      ]),
      fixture("parkapi-v3-sources.json"),
    );
    expect(out.features.map((f) => f["id"])).toEqual(["oc:feature:de-bw-mobidata-parking:2"]);
    expect(out.rejected).toBe(1);
  });
});
