import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { observationsToDatexSituations, toDatexRecordType } from "../datex.js";
import { roadEvent } from "./fixture.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (n) => n === "situation" || n === "situationRecord" || n === "value",
});

function parse(xml: string) {
  return parser.parse(xml);
}

/** Local name of an xsi:type QName ("sit:Accident" → "Accident"). */
function local(qname: string | undefined): string | undefined {
  if (!qname) return qname;
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}

function payloadOf(xml: string) {
  return parse(xml).messageContainer.payload;
}

/** situationRecord array of the first situation (situation + situationRecord are forced to arrays). */
function recordsOf(xml: string) {
  return payloadOf(xml).situation[0].situationRecord;
}

describe("toDatexRecordType", () => {
  it("maps canonical road types to DATEX II SituationRecord types", () => {
    expect(toDatexRecordType(roadEvent({ type: "accident" }))).toBe("Accident");
    expect(toDatexRecordType(roadEvent({ type: "roadworks" }))).toBe("MaintenanceWorks");
    expect(toDatexRecordType(roadEvent({ type: "congestion" }))).toBe("AbnormalTraffic");
    expect(toDatexRecordType(roadEvent({ type: "road_closure" }))).toBe(
      "RoadOrCarriagewayOrLaneManagement"
    );
  });
});

describe("observationsToDatexSituations", () => {
  it("emits a messageContainer > SituationPublication with a publication time", () => {
    const xml = observationsToDatexSituations([roadEvent()], {
      attribution: "OpenConditions",
      timestamp: "2026-06-23T10:00:00Z",
    });
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
    const payload = payloadOf(xml);
    expect(local(payload["@_type"])).toBe("SituationPublication");
    expect(payload.publicationTime).toBe("2026-06-23T10:00:00Z");
    expect(payload.publicationCreator.nationalIdentifier).toBe("OpenConditions");
  });

  it("emits one situationRecord per event with the right xsi:type and id", () => {
    const recs = recordsOf(
      observationsToDatexSituations([roadEvent({ id: "ndw:5", type: "accident" })])
    );
    expect(recs).toHaveLength(1);
    expect(local(recs[0]["@_type"])).toBe("Accident");
    expect(recs[0]["@_id"]).toBe("ndw:5");
  });

  it("writes the representative point as latitude/longitude", () => {
    const recs = recordsOf(
      observationsToDatexSituations([
        roadEvent({ geometry: { type: "Point", coordinates: [13.4, 52.5] } }),
      ])
    );
    const coords = recs[0].locationReference.pointByCoordinates.pointCoordinates;
    expect(Number(coords.latitude)).toBe(52.5);
    expect(Number(coords.longitude)).toBe(13.4);
  });

  it("emits a PointLocation for a Point-geometry event, never a buffered linear/area location", () => {
    const recs = recordsOf(
      observationsToDatexSituations([
        roadEvent({
          type: "congestion",
          geometry: { type: "Point", coordinates: [13.4, 52.5] },
        }),
      ])
    );
    const loc = recs[0].locationReference;
    expect(local(loc["@_type"])).toBe("PointLocation");
    expect(Number(loc.pointByCoordinates.pointCoordinates.latitude)).toBe(52.5);
    expect(Number(loc.pointByCoordinates.pointCoordinates.longitude)).toBe(13.4);
    expect(loc.linearLocation).toBeUndefined();
    expect(loc.area).toBeUndefined();
  });

  it("reduces a LineString event to its first coordinate as a PointLocation, never fabricating a linear location by buffering", () => {
    const recs = recordsOf(
      observationsToDatexSituations([
        roadEvent({
          type: "congestion",
          geometry: {
            type: "LineString",
            coordinates: [
              [13.4, 52.5],
              [13.5, 52.6],
            ],
          },
        }),
      ])
    );
    const loc = recs[0].locationReference;
    expect(local(loc["@_type"])).toBe("PointLocation");
    expect(Number(loc.pointByCoordinates.pointCoordinates.latitude)).toBe(52.5);
    expect(Number(loc.pointByCoordinates.pointCoordinates.longitude)).toBe(13.4);
    expect(loc.linearLocation).toBeUndefined();
    expect(loc.area).toBeUndefined();
  });

  it("maps severity (critical→highest) and overall validity times", () => {
    const recs = recordsOf(
      observationsToDatexSituations([
        roadEvent({
          severity: "critical",
          validFrom: "2026-06-23T08:00:00Z",
          validTo: "2026-06-23T12:00:00Z",
        }),
      ])
    );
    expect(recs[0].severity).toBe("highest");
    const spec = recs[0].validity.validityTimeSpecification;
    expect(spec.overallStartTime).toBe("2026-06-23T08:00:00Z");
    expect(spec.overallEndTime).toBe("2026-06-23T12:00:00Z");
  });

  it("emits a management type for closures (text contains 'closed')", () => {
    const recs = recordsOf(
      observationsToDatexSituations([roadEvent({ type: "road_closure", roadState: "closed" })])
    );
    expect(local(recs[0]["@_type"])).toBe("RoadOrCarriagewayOrLaneManagement");
    expect(String(recs[0].roadOrCarriagewayOrLaneManagementType).toLowerCase()).toContain("closed");
  });

  it("carries the headline as an English public comment", () => {
    const recs = recordsOf(
      observationsToDatexSituations([roadEvent({ headline: "Accident on A2" })])
    );
    const value = recs[0].generalPublicComment.comment.values.value[0];
    expect(value["#text"]).toBe("Accident on A2");
    expect(value["@_lang"]).toBe("en");
  });
});
