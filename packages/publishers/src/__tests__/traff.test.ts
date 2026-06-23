import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { observationsToTraff, traffEvents } from "../traff.js";
import { roadEvent } from "./fixture.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function parse(xml: string) {
  return parser.parse(xml);
}

const types = (codes: { cls: string; type: string }[]) => codes.map((c) => c.type);

describe("traffEvents", () => {
  it("maps each condition to its semantic primary event", () => {
    expect(types(traffEvents(roadEvent({ type: "road_closure" })))).toEqual(["RESTRICTION_CLOSED"]);
    expect(types(traffEvents(roadEvent({ type: "lane_closure" })))).toEqual([
      "RESTRICTION_LANE_CLOSED",
    ]);
    expect(types(traffEvents(roadEvent({ type: "roadworks", category: "planned" })))).toEqual([
      "CONSTRUCTION_ROADWORKS",
    ]);
    expect(types(traffEvents(roadEvent({ type: "accident" })))).toEqual(["INCIDENT_ACCIDENT"]);
    expect(types(traffEvents(roadEvent({ type: "congestion", category: "conditions" })))).toEqual([
      "CONGESTION_TRAFFIC_CONGESTION",
    ]);
    expect(types(traffEvents(roadEvent({ type: "hazard", category: "conditions" })))).toEqual([
      "HAZARD_HAZARD",
    ]);
    expect(types(traffEvents(roadEvent({ type: "authority" })))).toEqual(["AUTHORITY_CHECKPOINT"]);
  });

  it("adds a RESTRICTION effect event when the road state restricts traffic", () => {
    const codes = traffEvents(roadEvent({ type: "accident", roadState: "closed" }));
    expect(types(codes)).toEqual(["INCIDENT_ACCIDENT", "RESTRICTION_CLOSED"]);
  });

  it("maps dimension_restriction to the matching RESTRICTION_MAX_* code", () => {
    expect(
      types(
        traffEvents(
          roadEvent({ type: "dimension_restriction", restrictions: [{ type: "height", value: 4 }] })
        )
      )
    ).toEqual(["RESTRICTION_MAX_HEIGHT"]);
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

  it("writes a LineString as <from>/<to> with junction_name + distance, directionality", () => {
    const xml = observationsToTraff([
      roadEvent({
        geometry: {
          type: "LineString",
          coordinates: [
            [13.0, 52.0],
            [13.2, 52.2],
          ],
        },
        roads: [{ name: "A2", from: "Exit 1", to: "Exit 5", milepostFrom: 10, milepostTo: 25 }],
      }),
    ]);
    const loc = parse(xml).feed.message.location;
    expect(loc["@_directionality"]).toBe("ONE_DIRECTION");
    expect(loc.from["#text"]).toBe("+52 +13");
    expect(loc.from["@_junction_name"]).toBe("Exit 1");
    expect(loc.from["@_distance"]).toBe("10"); // attribute values are strings on the wire
    expect(loc.to["@_junction_name"]).toBe("Exit 5");
  });

  it("emits urgency, speed/length and a diversion supplementary_info", () => {
    const xml = observationsToTraff([
      roadEvent({
        type: "congestion",
        category: "conditions",
        severity: "critical",
        speedLimitKph: 50,
        queueLengthMeters: 1200,
        detour: "Use A4",
      }),
    ]);
    const msg = parse(xml).feed.message;
    expect(msg["@_urgency"]).toBe("X_URGENT");
    expect(msg.events.event["@_speed"]).toBe("50");
    expect(msg.events.event["@_length"]).toBe("1200");
    expect(msg.events.event.supplementary_info["@_class"]).toBe("DIVERSION");
    expect(msg.events.event.supplementary_info["@_type"]).toBe("S_DIVERSION_IN_OPERATION");
  });

  it("emits two <event>s for a cause + restriction effect", () => {
    const xml = observationsToTraff([roadEvent({ type: "accident", roadState: "closed" })]);
    const events = parse(xml).feed.message.events.event;
    expect(Array.isArray(events)).toBe(true);
    expect(events.map((e: { "@_type": string }) => e["@_type"])).toEqual([
      "INCIDENT_ACCIDENT",
      "RESTRICTION_CLOSED",
    ]);
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
