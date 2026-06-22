import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { observationsToTraff, toTraffEventCode } from "../traff.js";
import { roadEvent } from "./fixture.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function parse(xml: string) {
  return parser.parse(xml);
}

describe("toTraffEventCode", () => {
  it("maps conditions to confirmed routing-relevant Navit/TraFF codes", () => {
    expect(toTraffEventCode(roadEvent({ type: "road_closure" }))).toEqual({
      cls: "RESTRICTION",
      type: "RESTRICTION_CLOSED",
    });
    expect(toTraffEventCode(roadEvent({ type: "accident", roadState: "closed" }))).toEqual({
      cls: "RESTRICTION",
      type: "RESTRICTION_CLOSED",
    });
    expect(toTraffEventCode(roadEvent({ type: "lane_closure" }))).toEqual({
      cls: "RESTRICTION",
      type: "RESTRICTION_LANE_CLOSED",
    });
    expect(toTraffEventCode(roadEvent({ type: "congestion", category: "conditions" }))).toEqual({
      cls: "CONGESTION",
      type: "CONGESTION_TRAFFIC_CONGESTION",
    });
    expect(toTraffEventCode(roadEvent({ type: "roadworks", category: "planned" }))).toEqual({
      cls: "RESTRICTION",
      type: "RESTRICTION_REDUCED_LANES",
    });
    expect(toTraffEventCode(roadEvent({ type: "accident" }))).toEqual({
      cls: "RESTRICTION",
      type: "RESTRICTION_BLOCKED",
    });
    expect(toTraffEventCode(roadEvent({ type: "contraflow", category: "conditions" }))).toEqual({
      cls: "RESTRICTION",
      type: "RESTRICTION_CONTRAFLOW",
    });
  });
});

describe("observationsToTraff", () => {
  it("emits a feed>message>events>event + location, with the message id and event code", () => {
    const xml = observationsToTraff([
      roadEvent({
        id: "ndw:42",
        type: "road_closure",
        roads: [{ name: "A2", ref: "A2", roadClass: "MOTORWAY" }],
      }),
    ]);
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
    const doc = parse(xml);
    const msg = doc.feed.message;
    expect(msg["@_id"]).toBe("ndw:42");
    expect(msg.events.event["@_class"]).toBe("RESTRICTION");
    expect(msg.events.event["@_type"]).toBe("RESTRICTION_CLOSED");
    expect(msg.location["@_road_name"]).toBe("A2");
    expect(msg.location["@_road_class"]).toBe("MOTORWAY");
  });

  it("writes a Point as <at> in lat-lon order (latitude first)", () => {
    const xml = observationsToTraff([
      roadEvent({ geometry: { type: "Point", coordinates: [13.4, 52.5] } }),
    ]);
    const at = parse(xml).feed.message.location.at;
    expect(at).toBe("+52.5 +13.4");
  });

  it("writes a LineString as <from>/<to> using first/last vertices", () => {
    const xml = observationsToTraff([
      roadEvent({
        geometry: {
          type: "LineString",
          coordinates: [
            [13.0, 52.0],
            [13.1, 52.1],
            [13.2, 52.2],
          ],
        },
      }),
    ]);
    const loc = parse(xml).feed.message.location;
    expect(loc.from).toBe("+52 +13");
    expect(loc.to).toBe("+52.2 +13.2");
  });

  it("sets expiration_time from expiresAt and emits one message per event", () => {
    const xml = observationsToTraff([
      roadEvent({ id: "a", expiresAt: "2026-06-22T12:00:00Z" }),
      roadEvent({ id: "b", type: "congestion", category: "conditions" }),
    ]);
    const msgs = parse(xml).feed.message;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]["@_expiration_time"]).toBe("2026-06-22T12:00:00Z");
    expect(msgs[1].events.event["@_type"]).toBe("CONGESTION_TRAFFIC_CONGESTION");
  });
});
