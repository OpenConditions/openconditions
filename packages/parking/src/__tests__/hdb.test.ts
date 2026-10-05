import type { ParseOutput } from "@openconditions/ingest-framework";
import { describe, expect, test } from "vitest";
import { parseHdb, svy21ToWgs84 } from "../formats/hdb.js";
import { fixture, hdbFeed, parseContext } from "./helpers/parking-feed.js";
import { sealFailures } from "./helpers/seal.js";

const FETCHED = "2026-05-23T02:00:00Z";

function parse(sites: Buffer[], status: Buffer[]): ParseOutput {
  const out = parseHdb(hdbFeed(), { sites, status }, parseContext(FETCHED));
  expect(sealFailures([...out.features, ...out.observations, ...out.offers])).toEqual([]);
  return out;
}

const both = () => parse([fixture("singapore-static.json")], [fixture("singapore-live.json")]);

const site = (out: ParseOutput, stationId: string) =>
  out.features.find((f) => String(f["id"]).endsWith(`:${stationId}`));

/** `[property, area key or "site", value]` of each reading of a site. */
function readings(out: ParseOutput, stationId: string) {
  return out.observations
    .filter(
      (o) => (o["subject"] as { featureId: string }).featureId === site(out, stationId)?.["id"],
    )
    .map((o) => [
      o["property"],
      (o["subject"] as { componentKey?: string }).componentKey ?? "site",
      (o["result"] as { value: unknown }).value,
    ]);
}

const areas = (out: ParseOutput, stationId: string) =>
  (
    (site(out, stationId)?.["components"] ?? []) as {
      key: string;
      details: { capacity?: number };
    }[]
  ).map((c) => [c.key, c.details.capacity]);

describe("hdb", () => {
  test("HDB: SVY21 converts to WGS84 within 1e-6 and SGT times become UTC", () => {
    // Reference points from PROJ, EPSG:3414 to EPSG:4326.
    const acb = svy21ToWgs84(31490.4942, 30314.7936);
    expect(Math.abs(acb.lon - 103.85411805)).toBeLessThan(1e-6);
    expect(Math.abs(acb.lat - 1.301063272)).toBeLessThan(1e-6);
    const bbb = svy21ToWgs84(37976.93, 16207.8147);
    expect(Math.abs(bbb.lon - 103.727358)).toBeLessThan(1e-6);
    expect(Math.abs(bbb.lat - 1.359722046)).toBeLessThan(1e-6);

    const out = both();
    const location = site(out, "ACB")?.["location"] as { geometry: { coordinates: number[] } };
    const [lon, lat] = location.geometry.coordinates as [number, number];
    expect(Math.abs(lon - 103.85411805)).toBeLessThan(1e-6);
    expect(Math.abs(lat - 1.301063272)).toBeLessThan(1e-6);
    // `update_datetime` "2026-05-23T09:59:30" is Singapore time.
    const reading = out.observations.find((o) =>
      String((o["subject"] as { featureId: string }).featureId).endsWith(":ACB"),
    );
    expect(reading?.["phenomenonTime"]).toEqual({ instant: "2026-05-23T01:59:30Z" });
  });

  test("HDB: motorcycle and heavy-vehicle lots are their own areas", () => {
    const out = both();
    expect(areas(out, "ACB")).toEqual([
      ["car:any", 120],
      ["motorcycle:any", 10],
    ]);
    expect(readings(out, "ACB")).toEqual([
      ["parking.available", "site", 45],
      ["parking.available", "car:any", 45],
      ["parking.available", "motorcycle:any", 3],
    ]);
    const heavy = parse(
      [fixture("singapore-static.json")],
      [
        Buffer.from(
          JSON.stringify({
            items: [
              {
                timestamp: "2026-05-23T10:00:00+08:00",
                carpark_data: [
                  {
                    carpark_number: "BBB",
                    update_datetime: "2026-05-23T09:59:35",
                    carpark_info: [
                      { total_lots: "60", lot_type: "C", lots_available: "20" },
                      { total_lots: "4", lot_type: "H", lots_available: "5" },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
      ],
    );
    expect(areas(heavy, "BBB")).toEqual([
      ["car:any", 60],
      ["truck:any", 4],
    ]);
    // Five free of four heavy-vehicle lots is no reading.
    expect(readings(heavy, "BBB")).toEqual([
      ["parking.available", "site", 20],
      ["parking.available", "car:any", 20],
    ]);
  });

  test("HDB: a car park's type, gantry height and free parking are kept", () => {
    const out = both();
    expect(site(out, "ACB")).toMatchObject({
      name: [{ lang: "en", text: "Blk 270/271 Albert Centre Basement Car Park" }],
      location: { address: { text: "BLK 270/271 ALBERT CENTRE BASEMENT CAR PARK", country: "SG" } },
      details: {
        layout: "underground",
        capacityTotal: 120,
        heightLimit: { value: 1.8, unit: "m" },
      },
    });
    expect(site(out, "ACB")?.["details"]).not.toHaveProperty("tariffText");
    const bbb = site(out, "BBB");
    expect(bbb).toMatchObject({
      details: {
        layout: "surface",
        tariffText: [{ lang: "en", text: "Free parking: SUN & PH FR 7AM-10.30PM" }],
      },
    });
    // Free on Sundays and holidays only: not a free car park.
    expect(bbb).not.toHaveProperty("access");
    expect(bbb?.["details"]).not.toHaveProperty("heightLimit");
  });

  test("HDB: car lots without a count above zero give no site readings", () => {
    const out = parse(
      [fixture("singapore-static.json")],
      [
        Buffer.from(
          JSON.stringify({
            items: [
              {
                carpark_data: [
                  {
                    carpark_number: "ACB",
                    update_datetime: "2026-05-23T09:59:30",
                    carpark_info: [
                      { total_lots: "0", lot_type: "C", lots_available: "0" },
                      { total_lots: "10", lot_type: "Y", lots_available: "3" },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
      ],
    );
    expect(areas(out, "ACB")).toEqual([["motorcycle:any", 10]]);
    expect(site(out, "ACB")?.["details"]).not.toHaveProperty("capacityTotal");
    expect(readings(out, "ACB")).toEqual([["parking.available", "motorcycle:any", 3]]);
  });

  test("HDB: sites without the live payload have no areas and no readings", () => {
    const out = parse([fixture("singapore-static.json")], []);
    expect(out.features).toHaveLength(2);
    expect(out.observations).toEqual([]);
    expect(site(out, "ACB")).not.toHaveProperty("components");
  });
});
