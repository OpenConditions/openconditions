import { describe, expect, it } from "vitest";
import { parsePredefinedLocations } from "../predefined-locations.js";
import { fixture, flowFeed, flows, readings, site, siteIds, value } from "./flow-fixtures.js";

const FEED = "de-nw-autobahn-los-flow";
const feed = flowFeed(FEED);
const sites = parsePredefinedLocations(fixture("autobahn-bab/verortung.xml"));
const xml = fixture("autobahn-bab/elaborated.xml");

const doc = (...items: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <payloadPublication xsi:type="ElaboratedDataPublication">
    ${items.map((i) => `<elaboratedData>${i}</elaboratedData>`).join("\n")}
  </payloadPublication>
</d2LogicalModel>`;
const at = (inner: string, type: string) => `<basicData xsi:type="${type}">${inner}
  <pertinentLocation xsi:type="Location"><predefinedLocationReference id="MQ_A1_0042"/></pertinentLocation>
</basicData>`;

describe("DATEX elaborated data", () => {
  it("drafts one site per location, placed by the predefined locations", () => {
    const out = flows(feed, xml, sites);
    expect(siteIds(out, FEED)).toEqual(["MQ_A1_0042", "MQ_A7_0100"]);
    expect((site(out, FEED, "MQ_A1_0042")!["location"] as { geometry: unknown }).geometry).toEqual({
      type: "Point",
      coordinates: [10.0574, 53.60864],
    });
  });

  it("keeps speed (v), volume (q) and the stated status", () => {
    const out = flows(feed, xml, sites);
    expect(value(out, FEED, "MQ_A1_0042", "traffic.speed")).toBe(48);
    expect(value(out, FEED, "MQ_A1_0042", "traffic.volume")).toBe(1800);
    expect(value(out, FEED, "MQ_A1_0042", "traffic.los")).toBe("heavy");
    // Heavy is no congestion.
    expect(out.situations).toEqual([]);
  });

  it("refuses a document that is no ElaboratedDataPublication", () => {
    expect(() => flows(feed, "<foo/>", sites)).toThrow("hard parse failure");
  });

  it("maps a 'congested' status, nested or a plain-text leaf, to queuing with a situation", () => {
    for (const status of [
      "<trafficStatus><trafficStatusValue>congested</trafficStatusValue></trafficStatus>",
      "<trafficStatus>congested</trafficStatus>",
    ]) {
      const out = flows(feed, doc(at(status, "TrafficStatus")), sites);
      expect(value(out, FEED, "MQ_A1_0042", "traffic.los")).toBe("queuing");
      expect(out.situations).toHaveLength(1);
    }
  });

  it("never publishes a dataError-flagged volume", () => {
    const out = flows(
      feed,
      doc(
        at(
          `<averageVehicleSpeed numberOfInputValuesUsed="20"><speed>48</speed></averageVehicleSpeed>`,
          "TrafficSpeed",
        ),
        at(
          `<vehicleFlow><dataError>true</dataError><vehicleFlowRate>9999</vehicleFlowRate></vehicleFlow>`,
          "TrafficFlow",
        ),
      ),
      sites,
    );
    expect(value(out, FEED, "MQ_A1_0042", "traffic.speed")).toBe(48);
    expect(readings(out, FEED, "MQ_A1_0042", "traffic.volume")).toEqual([]);
  });

  it("weights the site speed by vehicle counts across classes", () => {
    const out = flows(
      feed,
      doc(
        at(
          `<forVehiclesWithCharacteristicsOf><vehicleType>car</vehicleType></forVehiclesWithCharacteristicsOf>
           <averageVehicleSpeed numberOfInputValuesUsed="30"><speed>100</speed></averageVehicleSpeed>`,
          "TrafficSpeed",
        ),
        at(
          `<forVehiclesWithCharacteristicsOf><vehicleType>lorry</vehicleType></forVehiclesWithCharacteristicsOf>
           <averageVehicleSpeed numberOfInputValuesUsed="10"><speed>80</speed></averageVehicleSpeed>`,
          "TrafficSpeed",
        ),
      ),
      sites,
    );
    expect(value(out, FEED, "MQ_A1_0042", "traffic.speed")).toBe(95);
    expect(value(out, FEED, "MQ_A1_0042", "traffic.speed", "speed:truck")).toBe(80);
  });
});

describe("DATEX elaborated data — Verkehrslage (status only)", () => {
  const out = () => flows(feed, fixture("autobahn-bab/verkehrslage.xml"), sites);

  it("states the level of service without a speed", () => {
    const o = out();
    expect(readings(o, FEED, "MQ_A1_0042", "traffic.speed")).toEqual([]);
    expect(value(o, FEED, "MQ_A1_0042", "traffic.los")).toBe("queuing");
    expect(value(o, FEED, "MQ_A7_0100", "traffic.los")).toBe("free_flow");
  });

  it("derives a congestion situation for the queuing site only", () => {
    expect(out().situations.map((s) => s["id"])).toEqual([
      `oc:situation:${FEED}:MQ_A1_0042:congestion`,
    ]);
  });
});
