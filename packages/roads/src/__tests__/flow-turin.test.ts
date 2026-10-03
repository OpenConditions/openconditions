import { describe, expect, it } from "vitest";
import { flowFeed, flows, readings, site, siteIds, value } from "./flow-fixtures.js";

const FEED = "it-turin-flow";
const feed = flowFeed(FEED);

const XML = `<?xml version="1.0" encoding="utf-8"?>
<traffic_data xmlns="https://simone.5t.torino.it/ns/traffic_data.xsd" generation_time="2026-07-10T18:00:03.516Z">
  <FDT_data lcd1="39983" Road_name="Corso Allamano(TO)" direction="positive" lat="45.0507" lng="7.6225" accuracy="95" period="5"><speedflow flow="360" speed="54.5"/></FDT_data>
  <FDT_data lcd1="40121" Road_name="Corso Regina Margherita(TO)" direction="positive" lat="45.096231" lng="7.625643" accuracy="0" period="5"><speedflow flow="0" speed="0"/></FDT_data>
</traffic_data>`;

describe("Turin FDT", () => {
  it("places the detector at its inline point with its km/h speed, dropping accuracy=0 detectors", () => {
    const out = flows(feed, XML);
    expect(siteIds(out, FEED)).toEqual(["39983"]);
    expect(value(out, FEED, "39983", "traffic.speed")).toBe(54.5);
    const location = site(out, FEED, "39983")!["location"] as {
      geometry: unknown;
      direction: unknown;
    };
    expect(location.geometry).toEqual({ type: "Point", coordinates: [7.6225, 45.0507] });
    expect(location.direction).toEqual({ value: "positive", basis: "alert_c" });
    expect(readings(out, FEED, "39983", "traffic.speed")[0]!["phenomenonTime"]).toMatchObject({
      end: "2026-07-10T18:00:03.516Z",
    });
  });

  it("refuses an unreadable body as a hard parse failure", () => {
    expect(() => flows(feed, "not xml <")).toThrow("hard parse failure");
  });
});
