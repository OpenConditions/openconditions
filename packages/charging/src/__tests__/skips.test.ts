import { __resetSkips, drainSkipped, type FeedPayloads } from "@openconditions/ingest-framework";
import { beforeEach, describe, expect, test } from "vitest";
import { chargingDomain } from "../domain.js";
import { unplacedReason } from "../formats/raw.js";
import { catalogFeed, parseContext } from "./helpers/charging-feed.js";

const FETCHED = "2026-07-31T12:00:00Z";
const json = (value: unknown) => [Buffer.from(JSON.stringify(value))];

function parse(format: string, feedId: string, payloads: FeedPayloads) {
  const feed = catalogFeed(feedId);
  const out = chargingDomain.formats[format]!.parse(feed, payloads, parseContext(FETCHED));
  return { out, skipped: drainSkipped(feed.id) };
}

describe("charging skip reasons", () => {
  beforeEach(() => __resetSkips());

  test("a position not written, or written as the null island, is no geometry; an unreadable one is malformed", () => {
    expect(unplacedReason(undefined, "8.5")).toBe("no_geometry");
    expect(unplacedReason(null, null)).toBe("no_geometry");
    expect(unplacedReason("0", "0,0")).toBe("no_geometry");
    expect(unplacedReason("147.3", "8.5")).toBe("malformed");
    expect(unplacedReason("north", "8.5")).toBe("malformed");
  });

  test("OICP: a record without an EVSE id is malformed, one off the globe malformed, one without coordinates no geometry", () => {
    const records = [
      { Plugs: ["Type 2 Outlet"], GeoCoordinates: { Google: "47.37 8.54" } },
      { EvseID: "CH*ABC*E1", GeoCoordinates: { DecimalDegree: { Latitude: 147, Longitude: 8 } } },
      { EvseID: "CH*ABC*E2" },
      { EvseID: "CH*ABC*E3", Plugs: ["Type 9 Plug"], GeoCoordinates: { Google: "47.37 8.54" } },
    ];
    const { out, skipped } = parse("oicp", "ch-bfe-charging", {
      main: json({ EVSEData: [{ OperatorID: "CH*ABC", EVSEDataRecord: records }] }),
    });
    expect(out.features).toHaveLength(1);
    expect(out.rejected ?? 0).toBe(0);
    // The kept record's plug is not one of OICP's.
    expect(skipped).toEqual({ malformed: 2, no_geometry: 1, unknown_value: 1 });
  });

  test("OICP: a status poll counts a status outside OICP's list as unread, an unplaced EVSE as rejected", () => {
    const feed = catalogFeed("ch-bfe-charging");
    const format = chargingDomain.formats["oicp"]!;
    const full = format.parse(
      feed,
      {
        main: json({
          EVSEData: [
            {
              OperatorID: "CH*ABC",
              EVSEDataRecord: [{ EvseID: "CH*ABC*E1", GeoCoordinates: { Google: "47.37 8.54" } }],
            },
          ],
        }),
      },
      parseContext(FETCHED),
    );
    drainSkipped(feed.id);
    const status = format.parseStatus!(
      feed,
      {
        status: json({
          EVSEStatuses: [
            {
              EVSEStatusRecord: [
                { EvseID: "CH*ABC*E1", EvseStatus: "Hovering" },
                { EvseID: "CH*ABC*E9", EvseStatus: "Available" },
              ],
            },
          ],
        }),
      },
      parseContext(FETCHED),
      full.statusIndex!,
    );
    expect(status.observations).toEqual([]);
    expect(status.rejected).toBe(1);
    expect(drainSkipped(feed.id)).toEqual({ unknown_value: 1 });
  });

  test("Digitraffic: a feature the decoder refuses is counted by why", () => {
    const placed = { type: "Point", coordinates: [24.94, 60.17] };
    const { out, skipped } = parse("digitraffic", "fi-digitraffic-charging", {
      main: json({
        features: [
          { geometry: placed, properties: { name: "no id" } },
          { geometry: null, properties: { id: "L2" } },
          { geometry: { type: "Point", coordinates: [24.94, 160.17] }, properties: { id: "L3" } },
        ],
      }),
    });
    expect(out.features).toEqual([]);
    expect(out.rejected ?? 0).toBe(0);
    expect(skipped).toEqual({ malformed: 2, no_geometry: 1 });
  });

  test("AFDC: a station listed again under its id is malformed, once", () => {
    const station = { id: 7, fuel_type_code: "ELEC", latitude: 40.1, longitude: -105.2 };
    const { out, skipped } = parse("afdc", "us-afdc-charging", {
      main: json({ fuel_stations: [station, station, "not a station"] }),
    });
    expect(out.features).toHaveLength(1);
    expect(skipped).toEqual({ malformed: 2 });
  });

  test("KECO: a charger's state outside the API's codes is counted once, and gives no reading", () => {
    const item = { statId: "ME1", chgerId: "01", lat: "37.5", lng: "127.0", chgerType: "02" };
    const { out, skipped } = parse("keco", "kr-keco-charging", {
      main: json({ items: { item: [{ ...item, stat: "7", statUpdDt: "20260731200000" }] } }),
    });
    expect(out.features).toHaveLength(1);
    expect(out.observations).toEqual([]);
    expect(skipped).toEqual({ unknown_value: 1 });
  });
});
