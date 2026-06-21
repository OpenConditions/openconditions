import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDatexSituations } from "../datex.js";

const NDW_FIXTURE_PATH = join(
  import.meta.dirname,
  "fixtures/ndw/actueel_beeld.xml",
);

const NDW_SOURCE = {
  id: "ndw",
  attribution: "NDW / Rijkswaterstaat",
  country: "NL",
  license: "CC0-1.0",
  licenseUrl: "https://www.ndw.nu",
} as const;

describe("parseDatexSituations — NDW actueel_beeld.xml fixture", () => {
  it("parses at least one RoadEvent with a Point geometry", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    expect(events.length).toBeGreaterThan(0);

    const pointEvent = events.find((ev) => ev.geometry.type === "Point");
    expect(pointEvent).toBeDefined();
  });

  it("emits sourceFormat:'datex2' and domain:'roads' on every event", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    expect(events.every((ev) => ev.sourceFormat === "datex2")).toBe(true);
    expect(events.every((ev) => ev.domain === "roads")).toBe(true);
  });

  it("maps at least one event to a non-other type", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    const nonOther = events.filter((ev) => ev.type !== "other");
    expect(nonOther.length).toBeGreaterThan(0);
  });

  it("carries CC0-1.0 license from the source descriptor", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.origin.kind).toBe("feed");
      if (ev.origin.kind === "feed") {
        expect(ev.origin.attribution.license).toBe("CC0-1.0");
      }
    }
  });

  it("sets kind:'event' and isStale:false on every event", () => {
    const xml = readFileSync(NDW_FIXTURE_PATH);
    const events = parseDatexSituations(xml, NDW_SOURCE);

    expect(events.every((ev) => ev.kind === "event")).toBe(true);
    expect(events.every((ev) => ev.isStale === false)).toBe(true);
  });
});

describe("parseDatexSituations — v2/v3 root tolerance", () => {
  it("handles DATEX II v2 D2LogicalModel root", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D2LogicalModel modelBaseVersion="2">
  <payloadPublication xsi:type="SituationPublication"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <publicationTime>2024-01-01T00:00:00Z</publicationTime>
    <situation id="S1">
      <situationRecord xsi:type="Accident" id="R1" version="1">
        <situationRecordVersionTime>2024-01-01T00:00:00Z</situationRecordVersionTime>
        <probabilityOfOccurrence>certain</probabilityOfOccurrence>
        <validity>
          <validityStatus>active</validityStatus>
          <validityTimeSpecification>
            <overallStartTime>2024-01-01T00:00:00Z</overallStartTime>
          </validityTimeSpecification>
        </validity>
        <locationReference xsi:type="PointLocation">
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>52.0</latitude>
              <longitude>4.5</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </locationReference>
      </situationRecord>
    </situation>
  </payloadPublication>
</D2LogicalModel>`;

    const events = parseDatexSituations(xml, NDW_SOURCE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("accident");
    expect(events[0]!.geometry.type).toBe("Point");
  });

  it("handles DATEX II v3 messageContainer/payload root", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<messageContainer xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  modelBaseVersion="3">
  <payload xsi:type="SituationPublication">
    <publicationTime>2024-01-01T00:00:00Z</publicationTime>
    <situation id="S2">
      <situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" id="R2" version="1">
        <situationRecordVersionTime>2024-01-01T00:00:00Z</situationRecordVersionTime>
        <probabilityOfOccurrence>certain</probabilityOfOccurrence>
        <validity>
          <validityStatus>active</validityStatus>
          <validityTimeSpecification>
            <overallStartTime>2024-01-01T00:00:00Z</overallStartTime>
          </validityTimeSpecification>
        </validity>
        <locationReference xsi:type="PointLocation">
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>51.5</latitude>
              <longitude>4.0</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </locationReference>
      </situationRecord>
    </situation>
  </payload>
</messageContainer>`;

    const events = parseDatexSituations(xml, NDW_SOURCE);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.type).toBe("lane_closure");
    expect(events[0]!.geometry.type).toBe("Point");
  });
});
