import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRegistry, type Effect, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { describe, expect, it } from "vitest";
import { travelDirectionOf } from "../bind/direction.js";
import { parseCifs, parseCifsSnapshot } from "../cifs.js";
import { parseEvents } from "../parse.js";
import { situationDrafts } from "../situation/assemble.js";
import type { SourceDescriptor } from "../types.js";
import { roadFeed } from "./helpers/road-feed.js";

const registry = buildRegistry([kernelModule, roadsModule]);

const SRC: SourceDescriptor = {
  id: "de-mobidata-bw-cifs",
  attribution: "MobiData BW",
  country: "DE",
  license: "DL-DE-BY-2.0",
  licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
};

const FIXTURE = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "cifs", name), "utf8");

function sealDrafts(
  input: string,
  src: SourceDescriptor = SRC,
  fetchedAt = "2026-09-01T10:00:00Z",
) {
  const report = parseCifsSnapshot(input, src);
  expect(report.errors).toEqual([]);
  const events = parseCifs(input, src);
  const drafts = situationDrafts(events, { source: src, records: report.records, fetchedAt });
  return drafts.map((draft) => {
    const sealed = sealRecord(registry, draft, {
      instanceId: "test.local",
      revision: 1,
      recordedAt: fetchedAt,
    });
    expect(sealed.ok, sealed.ok ? "" : JSON.stringify(sealed.issues)).toBe(true);
    return sealed.ok ? (sealed.value as Record<string, unknown>) : draft;
  });
}

describe("CIFS inbound parser", () => {
  it("parses real MobiData BW CIFS JSON fixture into sealed situations", () => {
    const raw = FIXTURE("mobidata-bw.json");
    const records = sealDrafts(raw);
    expect(records).toHaveLength(2);

    const works = records[0]!;
    expect(works["kind"]).toBe("roadworks");
    expect(works["type"]).toBe("works");
    expect(works["effects"]).toEqual([]); // Bare CONSTRUCTION is a works alert, not a closure
    expect((works["location"] as Record<string, unknown>)["direction"]).toEqual({
      value: "positive",
      basis: "geometry",
    });
    expect(works["externalIds"]).toContainEqual({
      scheme: "cifs:incident",
      id: "105025184-105025186-105025189-105025193.001",
    });
    const worksProv = works["provenance"] as Record<string, unknown>;
    expect(worksProv["informationSource"]).toEqual({ id: "MobiData BW" });
    expect(worksProv["attribution"]).toMatchObject({
      provider: "MobiData BW",
      license: "DL-DE-BY-2.0",
    });

    const closure = records[1]!;
    expect(closure["kind"]).toBe("roadworks");
    expect(closure["type"]).toBe("works");
    expect(closure["subtype"]).toBe("construction");
    const closureEffects = closure["effects"] as Effect[];
    expect(closureEffects).toHaveLength(1);
    expect(closureEffects[0]).toMatchObject({
      kind: "closure",
      scope: "road",
      normalization: "complete",
      applicability: { kind: "all" },
    });
    expect((closure["location"] as Record<string, unknown>)["direction"]).toEqual({
      value: "both",
      basis: "text",
      text: "BOTH_DIRECTIONS",
    });
  });

  it("parses flat XML incidents with source, parent_event, schedule, lanes, and deduplicated vertices", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<incidents timestamp="2026-09-01T10:00:00Z">
  <incident id="xml-inc-1">
    <parent_event id="event-marathon-2026"/>
    <creationtime>2026-09-01T08:00:00Z</creationtime>
    <updatetime>2026-09-01T09:30:00Z</updatetime>
    <source>
      <reference>city-ops</reference>
      <name>City Traffic Center</name>
      <url>https://traffic.example.org</url>
    </source>
    <type>HAZARD</type>
    <subtype>HAZARD_ON_ROAD_LANE_CLOSED</subtype>
    <description>Left lane closed for repairs</description>
    <street>Main Street</street>
    <polyline>48.100000 11.500000 48.100000 11.500000 48.105000 11.510000</polyline>
    <lanes>
      <lane>
        <order>0</order>
        <type>LANE</type>
        <status>CLOSED_LANE</status>
      </lane>
      <lane>
        <order>1</order>
        <type>LANE</type>
        <status>OPEN_LANE</status>
      </lane>
      <lane>
        <order>2</order>
        <type>SHOULDER</type>
        <status>CLOSED</status>
      </lane>
    </lanes>
    <starttime>2026-09-01T09:00:00+02:00</starttime>
    <endtime>2026-09-10T18:00:00+02:00</endtime>
    <schedule>
      <everyday>08:00-10:00</everyday>
      <monday>08:00-10:00,14:00-16:00</monday>
    </schedule>
  </incident>
</incidents>`;

    const [rec] = sealDrafts(xml);
    expect(rec!["kind"]).toBe("closure");
    expect(rec!["subtype"]).toBe("lane");
    expect(rec!["headline"]).toBeUndefined();
    expect(rec!["description"]).toEqual([{ lang: "und", text: "Left lane closed for repairs" }]);
    expect(rec!["externalIds"]).toEqual([
      { scheme: "cifs:incident", id: "xml-inc-1" },
      { scheme: "cifs:parent_event", id: "event-marathon-2026" },
    ]);
    const prov = rec!["provenance"] as Record<string, unknown>;
    expect(prov["sourceUpdatedAt"]).toBe("2026-09-01T09:30:00.000Z");
    expect(prov["informationSource"]).toEqual({
      id: "city-ops",
      name: [{ lang: "und", text: "City Traffic Center" }],
    });
    // Consecutive duplicate coordinate collapsed to 2 vertices, omitted direction on line → positive/geometry
    const loc = rec!["location"] as Record<string, unknown>;
    expect(loc["geometry"]).toEqual({
      type: "LineString",
      coordinates: [
        [11.5, 48.1],
        [11.51, 48.105],
      ],
    });
    expect(loc["direction"]).toEqual({ value: "positive", basis: "geometry" });
    expect(travelDirectionOf(loc["direction"] as Record<string, unknown>)).toEqual({
      kind: "along",
    });

    // 0-based order shifted to 1-based; SHOULDER filtered out → 2 traffic lanes, 1 closed
    const [eff] = rec!["effects"] as Effect[];
    expect(eff).toMatchObject({
      kind: "lane_restriction",
      normalization: "complete",
      vehicleImpact: "some_lanes_closed",
      lanesTotal: 2,
      lanesClosed: 1,
      lanes: [
        { index: 1, status: "closed" },
        { index: 2, status: "open" },
      ],
    });

    // Everyday merged with Monday: 08:00-10:00 daily + 14:00-16:00 Monday
    const validity = rec!["validity"] as { periods?: Array<Record<string, unknown>> };
    expect(validity.periods).toHaveLength(2);
    expect(validity.periods).toContainEqual(
      expect.objectContaining({
        repeatFrequency: "P1D",
        startTime: "08:00",
        endTime: "10:00",
        duration: "PT2H",
        scheduleTimezone: "Europe/Berlin",
      }),
    );
    expect(validity.periods).toContainEqual(
      expect.objectContaining({
        repeatFrequency: "P1W",
        byDay: ["MO"],
        startTime: "14:00",
        endTime: "16:00",
        duration: "PT2H",
        scheduleTimezone: "Europe/Berlin",
      }),
    );
  });

  it("supports wrapped JSON incidents and maps ACCIDENT_MAJOR/MINOR severity", () => {
    const json = JSON.stringify({
      incidents: [
        {
          incident: {
            id: "acc-major-1",
            type: "ACCIDENT",
            subtype: "ACCIDENT_MAJOR",
            description: "Multi-car crash",
            street: "I-95",
            polyline: "40.7128 -74.0060",
            direction: "BOTH_DIRECTIONS",
          },
        },
        {
          id: "acc-minor-1",
          type: "ACCIDENT",
          subtype: "ACCIDENT_MINOR",
          description: "Fender bender",
          street: "I-95",
          polyline: "40.7128 -74.0060",
          direction: "ONE_DIRECTION",
        },
      ],
    });

    const records = sealDrafts(json);
    expect(records).toHaveLength(2);
    expect(records[0]!["severity"]).toMatchObject({ label: "major", source: "derived" });
    expect(records[1]!["severity"]).toMatchObject({ label: "minor", source: "derived" });
    // Single-point ONE_DIRECTION preserves unplaced single-direction constraint
    const dir = (records[1]!["location"] as Record<string, unknown>)["direction"] as Record<
      string,
      unknown
    >;
    expect(dir).toEqual({ value: "positive", basis: "unknown", text: "ONE_DIRECTION" });
    expect(travelDirectionOf(dir)).toEqual({ kind: "unplaced" });
  });

  it("retains point-only ROAD_CLOSED as partial non-routing evidence", () => {
    const json = JSON.stringify({
      incidents: [
        {
          id: "point-closure-1",
          type: "ROAD_CLOSED",
          subtype: "ROAD_CLOSED_EVENT",
          description: "Parade",
          street: "Broadway",
          polyline: "40.7580 -73.9855",
          direction: "BOTH_DIRECTIONS",
          starttime: "2026-09-01T08:00:00Z",
        },
      ],
    });

    const [rec] = sealDrafts(json);
    expect(rec!["kind"]).toBe("public_event");
    const [eff] = rec!["effects"] as Effect[];
    expect(eff).toMatchObject({
      kind: "closure",
      normalization: "partial",
      issues: [expect.objectContaining({ code: "invalid_value", sourcePath: "polyline" })],
    });
  });

  it("handles lane_impact and flags conflicting/invalid partial lane data without synthesizing all_lanes_closed", () => {
    const json = JSON.stringify({
      incidents: [
        {
          id: "impact-ok",
          type: "HAZARD",
          subtype: "HAZARD_ON_ROAD_CONSTRUCTION",
          description: "Right lane closed",
          street: "B10",
          polyline: "48.7800 9.1800 48.7850 9.1850",
          direction: "ONE_DIRECTION",
          lane_impact: { total_closed_lanes: 1, roadside: "RIGHT" },
        },
        {
          id: "lanes-all-closed",
          type: "HAZARD",
          subtype: "HAZARD_ON_ROAD_LANE_CLOSED",
          description: "All listed lanes closed",
          street: "B10",
          polyline: "48.7800 9.1800 48.7850 9.1850",
          direction: "ONE_DIRECTION",
          lanes: [
            { order: 1, type: "LANE", status: "CLOSED" },
            { order: 2, type: "LANE", status: "CLOSED" },
          ],
        },
        {
          id: "lanes-conflict",
          type: "HAZARD",
          subtype: "HAZARD_ON_ROAD_LANE_CLOSED",
          description: "Conflicting lane impact",
          street: "B10",
          polyline: "48.7800 9.1800 48.7850 9.1850",
          direction: "ONE_DIRECTION",
          lanes: [
            { order: 1, type: "LANE", status: "CLOSED" },
            { order: 2, type: "LANE", status: "OPEN" },
          ],
          lane_impact: { total_closed_lanes: 2, roadside: "LEFT" },
        },
        {
          id: "lanes-both-dirs",
          type: "HAZARD",
          subtype: "HAZARD_ON_ROAD_LANE_CLOSED",
          description: "Both directions with lanes",
          street: "B10",
          polyline: "48.7800 9.1800 48.7850 9.1850",
          direction: "BOTH_DIRECTIONS",
          lanes: [
            { order: 1, type: "LANE", status: "CLOSED" },
            { order: 2, type: "LANE", status: "OPEN" },
          ],
        },
      ],
    });

    const records = sealDrafts(json);
    expect(records).toHaveLength(4);
    expect((records[0]!["effects"] as Effect[])[0]).toMatchObject({
      kind: "lane_restriction",
      normalization: "complete",
      vehicleImpact: "some_lanes_closed",
      lanesClosed: 1,
    });
    expect((records[1]!["effects"] as Effect[])[0]).toMatchObject({
      kind: "lane_restriction",
      normalization: "partial",
      vehicleImpact: "unknown",
    });
    expect((records[2]!["effects"] as Effect[])[0]).toMatchObject({
      kind: "lane_restriction",
      normalization: "partial",
      vehicleImpact: "unknown",
    });
    expect((records[3]!["effects"] as Effect[])[0]).toMatchObject({
      kind: "lane_restriction",
      normalization: "partial",
      vehicleImpact: "unknown",
    });
  });

  it("marks inverted starttime/endtime and malformed schedules as validity.status = unknown", () => {
    const json = JSON.stringify({
      incidents: [
        {
          id: "inverted-window",
          type: "ACCIDENT",
          description: "Crash",
          street: "A8",
          polyline: "48.70 9.20 48.71 9.21",
          starttime: "2026-09-05T10:00:00Z",
          endtime: "2026-09-01T10:00:00Z",
        },
        {
          id: "equal-schedule",
          type: "ROAD_CLOSED",
          description: "Closure with bad schedule",
          street: "A8",
          polyline: "48.70 9.20 48.71 9.21",
          starttime: "2026-09-01T10:00:00Z",
          schedule: { monday: "09:00-09:00" },
        },
      ],
    });

    const records = sealDrafts(json);
    const inverted = records.find(
      (r) => r["id"] === "oc:situation:de-mobidata-bw-cifs:inverted-window",
    )!;
    const badSched = records.find(
      (r) => r["id"] === "oc:situation:de-mobidata-bw-cifs:equal-schedule",
    )!;
    expect((inverted["validity"] as Record<string, unknown>)["status"]).toBe("unknown");
    expect((badSched["validity"] as Record<string, unknown>)["status"]).toBe("unknown");
    const [eff] = badSched["effects"] as Effect[];
    expect(eff!.issues).toContainEqual(
      expect.objectContaining({ code: "unsupported_schedule", sourcePath: "schedule.monday" }),
    );
  });

  it("accounts CHIT_CHAT as terminal and missing polyline as unlocatable", () => {
    const json = JSON.stringify({
      incidents: [
        {
          id: "chat-1",
          type: "CHIT_CHAT",
          description: "Hello",
          street: "A1",
          polyline: "48.0 9.0",
        },
        { id: "noloc-1", type: "ACCIDENT", description: "Crash", street: "A1" },
      ],
    });
    const report = parseCifsSnapshot(json, SRC);
    expect(report.errors).toEqual([]);
    expect(report.inputCount).toBe(2);
    expect(report.records.map((r) => [r.id, r.disposition])).toEqual([
      ["de-mobidata-bw-cifs:chat-1", "terminal"],
      ["de-mobidata-bw-cifs:noloc-1", "unlocatable"],
    ]);
  });

  it("rejects wrong roots, error envelopes, subtype mismatches, contradictory location, and mixed wrappers", () => {
    expect(() => parseCifsSnapshot("<feed/>", SRC)).toThrow(/<incidents>/);
    expect(() => parseCifsSnapshot("<incidents><error>down</error></incidents>", SRC)).toThrow(
      /unexpected XML child/,
    );
    expect(() =>
      parseCifsSnapshot(JSON.stringify({ error: "unauthorized", incidents: [] }), SRC),
    ).toThrow(/error envelope/);
    expect(() => parseCifsSnapshot("[]", SRC)).toThrow(/unrecognized payload/);

    // Valid empty feeds return 0 records and 0 errors
    expect(parseCifsSnapshot("<incidents/>", SRC)).toEqual({
      inputCount: 0,
      records: [],
      errors: [],
    });
    expect(parseCifsSnapshot(JSON.stringify({ incidents: [] }), SRC)).toEqual({
      inputCount: 0,
      records: [],
      errors: [],
    });

    // Subtype mismatch, contradictory flat vs legacy location, mixed wrapper
    const bad = JSON.stringify({
      incidents: [
        {
          id: "mismatch-1",
          type: "HAZARD",
          subtype: "ROAD_CLOSED_EVENT",
          description: "Bad pair",
          street: "Main St",
          polyline: "48.0 9.0 48.1 9.1",
        },
        {
          id: "conflict-loc",
          type: "ACCIDENT",
          description: "Conflict",
          street: "Main St",
          polyline: "48.0 9.0 48.1 9.1",
          location: { street: "Other St", polyline: "48.0 9.0 48.1 9.1" },
        },
        {
          incident: { id: "mixed-1", type: "ACCIDENT" },
          extra: true,
        },
      ],
    });
    const report = parseCifsSnapshot(bad, SRC);
    expect(report.errors.map((e) => e.code)).toEqual([
      "invalid_subtype_pair",
      "conflicting_location",
      "invalid_record",
    ]);
    expect(() => parseCifs(bad, SRC)).toThrow(/snapshot parse error/);
  });

  it("defaults parseEvents to situationsComplete = false with bounded freshness and fails closed on mixed/conflicting polls", () => {
    const feed = roadFeed({
      id: "de-mobidata-bw-cifs",
      region: "de",
      format: "cifs",
      freshnessWindowSec: 600,
    });
    const fetchedAt = "2026-09-01T10:00:00.000Z";
    const okOut = parseEvents(feed, [Buffer.from(FIXTURE("mobidata-bw.json"))], { fetchedAt });
    expect(okOut.situationsComplete).toBe(false);
    expect(okOut.situations).toHaveLength(2);
    expect(okOut.records?.inputCount).toBe(2);
    expect(okOut.records?.accepted).toBe(2);
    expect((okOut.situations[0]!["freshness"] as Record<string, unknown>)["expiresAt"]).toBe(
      "2026-09-01T10:10:00.000Z",
    );

    // Qualified complete snapshot sets situationsComplete = true
    const completeFeed = roadFeed({
      id: "de-mobidata-bw-cifs",
      region: "de",
      format: "cifs",
      snapshot: { completeness: "complete" },
    });
    const completeOut = parseEvents(completeFeed, [Buffer.from("<incidents/>")], { fetchedAt });
    expect(completeOut.situationsComplete).toBe(true);
    expect(completeOut.situations).toEqual([]);
    expect(completeOut.records?.inputCount).toBe(0);

    // Mixed valid + malformed poll fails closed instead of partially withdrawing
    const mixed = JSON.stringify({
      incidents: [
        {
          id: "ok-1",
          type: "ACCIDENT",
          description: "Crash",
          street: "A1",
          polyline: "48.0 9.0 48.1 9.1",
        },
        {
          id: "bad-1",
          type: "NO_SUCH_TYPE",
          description: "Bad",
          street: "A1",
          polyline: "48.0 9.0 48.1 9.1",
        },
      ],
    });
    expect(() => parseEvents(feed, [Buffer.from(mixed)], { fetchedAt })).toThrow(/unknown_type/);

    // Conflicting duplicate IDs across payloads fail closed
    const a = JSON.stringify({
      incidents: [
        {
          id: "dup-1",
          type: "ACCIDENT",
          description: "Version A",
          street: "A1",
          polyline: "48.0 9.0 48.1 9.1",
        },
      ],
    });
    const b = JSON.stringify({
      incidents: [
        {
          id: "dup-1",
          type: "ACCIDENT",
          description: "Version B",
          street: "A1",
          polyline: "48.0 9.0 48.1 9.1",
        },
      ],
    });
    expect(() => parseEvents(feed, [Buffer.from(a), Buffer.from(b)], { fetchedAt })).toThrow(
      /snapshot version conflict/,
    );
  });

  it("rejects duplicate XML tags, failure envelopes, and malformed JSON timing fields", () => {
    // Explicit failure envelopes must never authorize an empty snapshot
    expect(() => parseCifsSnapshot(JSON.stringify({ success: false, incidents: [] }), SRC)).toThrow(
      /error envelope/,
    );
    expect(() => parseCifsSnapshot(JSON.stringify({ ok: false, incidents: [] }), SRC)).toThrow(
      /error envelope/,
    );
    expect(() =>
      parseCifsSnapshot(JSON.stringify({ status: "error", incidents: [] }), SRC),
    ).toThrow(/error envelope/);

    // Duplicate XML <direction> elements fail closed rather than collapsing to omitted direction
    const dupDirXml = `<?xml version="1.0" encoding="UTF-8"?>
<incidents>
  <incident id="dup-dir">
    <type>ROAD_CLOSED</type>
    <description>Closed</description>
    <street>Main St</street>
    <polyline>48.78 9.18 48.79 9.19</polyline>
    <direction>ONE_DIRECTION</direction>
    <direction>BOTH_DIRECTIONS</direction>
    <starttime>2026-09-01T08:00:00Z</starttime>
  </incident>
</incidents>`;
    const dupReport = parseCifsSnapshot(dupDirXml, SRC);
    expect(dupReport.errors).toContainEqual(expect.objectContaining({ code: "invalid_direction" }));

    // Numeric JSON endtime does not silently become an open-ended active closure
    const numEnd = JSON.stringify({
      incidents: [
        {
          id: "num-end",
          type: "ROAD_CLOSED",
          description: "Closed",
          street: "Main St",
          polyline: "48.78 9.18 48.79 9.19",
          starttime: "2026-09-01T08:00:00Z",
          endtime: 1788260000,
        },
      ],
    });
    const [rec] = sealDrafts(numEnd);
    expect((rec!["validity"] as Record<string, unknown>)["status"]).toBe("unknown");
  });

  it("keeps ROAD_CLOSED without starttime or with circular/>20km polyline non-routing", () => {
    const json = JSON.stringify({
      incidents: [
        {
          id: "closure-no-start",
          type: "ROAD_CLOSED",
          description: "Missing start",
          street: "A8",
          polyline: "48.78 9.18 48.79 9.19",
        },
        {
          id: "closure-circular",
          type: "ROAD_CLOSED",
          description: "Loop",
          street: "A8",
          polyline: "48.78 9.18 48.79 9.19 48.78 9.18",
          starttime: "2026-09-01T08:00:00Z",
        },
        {
          id: "closure-too-long",
          type: "ROAD_CLOSED",
          description: "Over 20km",
          street: "A8",
          polyline: "48.00 9.00 48.30 9.00",
          starttime: "2026-09-01T08:00:00Z",
        },
      ],
    });
    const records = sealDrafts(json);
    const byId = (local: string) =>
      records.find((r) => r["id"] === `oc:situation:de-mobidata-bw-cifs:${local}`)!;
    expect((byId("closure-no-start")["validity"] as Record<string, unknown>)["status"]).toBe(
      "unknown",
    );
    expect((byId("closure-circular")["effects"] as Effect[])[0]).toMatchObject({
      kind: "closure",
      normalization: "partial",
    });
    expect((byId("closure-too-long")["effects"] as Effect[])[0]).toMatchObject({
      kind: "closure",
      normalization: "partial",
    });
  });

  it("flags roadside conflicts between lanes and lane_impact, preserves source+reference, and rejects DST-crossing schedules", () => {
    const json = JSON.stringify({
      incidents: [
        {
          id: "roadside-conflict",
          type: "HAZARD",
          subtype: "HAZARD_ON_ROAD_LANE_CLOSED",
          description: "Left lane closed but impact says RIGHT",
          street: "B10",
          polyline: "48.78 9.18 48.79 9.19",
          direction: "ONE_DIRECTION",
          source: { name: "City Ops" },
          reference: "ops-ref-1",
          lanes: [
            { order: 1, type: "LANE", status: "CLOSED" },
            { order: 2, type: "LANE", status: "OPEN" },
          ],
          lane_impact: { total_closed_lanes: 1, roadside: "RIGHT" },
        },
        {
          id: "dst-spring",
          type: "ROAD_CLOSED",
          description: "Spring DST crossing",
          street: "B10",
          polyline: "48.78 9.18 48.79 9.19",
          starttime: "2026-03-28T00:00:00+01:00",
          endtime: "2026-03-30T23:59:00+02:00",
          schedule: { sunday: "01:00-04:00" },
        },
        {
          id: "dst-autumn",
          type: "ROAD_CLOSED",
          description: "Autumn DST crossing",
          street: "B10",
          polyline: "48.78 9.18 48.79 9.19",
          starttime: "2026-10-24T00:00:00+02:00",
          endtime: "2026-10-26T23:59:00+01:00",
          schedule: { sunday: "01:00-04:00" },
        },
        {
          id: "dst-safe-daytime",
          type: "ROAD_CLOSED",
          description: "Daytime schedule across spring DST",
          street: "B10",
          polyline: "48.78 9.18 48.79 9.19",
          starttime: "2026-03-28T00:00:00+01:00",
          endtime: "2026-03-30T23:59:00+02:00",
          schedule: { sunday: "08:00-12:00" },
        },
      ],
    });
    const records = sealDrafts(json);
    const byId = (local: string) =>
      records.find((r) => r["id"] === `oc:situation:de-mobidata-bw-cifs:${local}`)!;

    // Conflicting roadside downgraded to partial/unknown, while source.name + top-level reference both survived
    expect((byId("roadside-conflict")["effects"] as Effect[])[0]).toMatchObject({
      kind: "lane_restriction",
      normalization: "partial",
      vehicleImpact: "unknown",
    });
    expect(
      (byId("roadside-conflict")["provenance"] as Record<string, unknown>)["informationSource"],
    ).toEqual({
      id: "ops-ref-1",
      name: [{ lang: "und", text: "City Ops" }],
    });

    // Spring & autumn DST-crossing windows become validity.status = unknown; daytime window stays active
    expect((byId("dst-spring")["validity"] as Record<string, unknown>)["status"]).toBe("unknown");
    expect((byId("dst-autumn")["validity"] as Record<string, unknown>)["status"]).toBe("unknown");
    expect((byId("dst-safe-daytime")["validity"] as Record<string, unknown>)["status"]).toBe(
      "active",
    );
  });

  it("handles string error status envelopes, explicit JSON nulls, empty XML lanes, overnight/end-only DST, and duplicate XML source", () => {
    // String HTTP error status envelope must fail closed
    expect(() => parseCifsSnapshot(JSON.stringify({ status: "503", incidents: [] }), SRC)).toThrow(
      /error envelope/,
    );
    expect(() =>
      parseCifsSnapshot(JSON.stringify({ statusCode: "400", incidents: [] }), SRC),
    ).toThrow(/error envelope/);

    // Explicit JSON null on endtime leaves closure validity.status = unknown; null direction is rejected
    const nullFieldsJson = JSON.stringify({
      incidents: [
        {
          id: "null-endtime",
          type: "ROAD_CLOSED",
          description: "Closed",
          street: "B10",
          polyline: "48.78 9.18 48.79 9.19",
          starttime: "2026-09-01T08:00:00Z",
          endtime: null,
        },
        {
          id: "null-direction",
          type: "ROAD_CLOSED",
          description: "Closed",
          street: "B10",
          polyline: "48.78 9.18 48.79 9.19",
          starttime: "2026-09-01T08:00:00Z",
          direction: null,
        },
      ],
    });
    const nullReport = parseCifsSnapshot(nullFieldsJson, SRC);
    expect(nullReport.errors).toContainEqual(
      expect.objectContaining({ id: `${SRC.id}:null-direction`, code: "invalid_direction" }),
    );
    const nullEndRec = nullReport.records.find(
      (r) => r.disposition === "accepted" && r.event?.id === `${SRC.id}:null-endtime`,
    );
    expect(nullEndRec?.event?.situation?.validityStatus).toBe("unknown");

    // Empty XML <lane/> inside <lanes> is detected as malformed instead of dropped
    const emptyLaneXml = `<?xml version="1.0" encoding="UTF-8"?>
<incidents>
  <incident id="empty-lane">
    <type>HAZARD</type>
    <subtype>HAZARD_ON_ROAD_LANE_CLOSED</subtype>
    <description>Lane closed</description>
    <street>B10</street>
    <polyline>48.78 9.18 48.79 9.19</polyline>
    <direction>ONE_DIRECTION</direction>
    <lanes>
      <lane/>
      <lane><order>1</order><type>LANE</type><status>CLOSED</status></lane>
    </lanes>
  </incident>
</incidents>`;
    const [emptyLaneRec] = sealDrafts(emptyLaneXml);
    expect((emptyLaneRec!["effects"] as Effect[])[0]).toMatchObject({
      kind: "lane_restriction",
      normalization: "partial",
      vehicleImpact: "unknown",
    });

    // Duplicate XML <source> elements fail closed rather than silently dropping provenance
    const dupSourceXml = `<?xml version="1.0" encoding="UTF-8"?>
<incidents>
  <incident id="dup-source">
    <source><reference>ref-1</reference><name>Org A</name></source>
    <source><reference>ref-2</reference><name>Org B</name></source>
    <type>ACCIDENT</type>
    <description>Crash</description>
    <street>B10</street>
    <polyline>48.78 9.18 48.79 9.19</polyline>
  </incident>
</incidents>`;
    const dupSourceReport = parseCifsSnapshot(dupSourceXml, SRC);
    expect(dupSourceReport.errors).toContainEqual(
      expect.objectContaining({ id: `${SRC.id}:dup-source`, code: "invalid_source" }),
    );

    // Overnight Saturday 23:00-04:00 starting the evening before Sunday spring DST
    // when validStart is Sunday 00:00+01:00 still crosses DST, and end-only 2025 bounds are scanned
    const dstEdgeJson = JSON.stringify({
      incidents: [
        {
          id: "dst-overnight-sat",
          type: "ROAD_CLOSED",
          description: "Overnight across spring DST",
          street: "B10",
          polyline: "48.78 9.18 48.79 9.19",
          starttime: "2026-03-29T00:00:00+01:00",
          endtime: "2026-03-30T00:00:00+02:00",
          schedule: { saturday: "23:00-04:00" },
        },
        {
          id: "dst-end-only-2025",
          type: "HAZARD",
          description: "End-only 2025 schedule",
          street: "B10",
          polyline: "48.78 9.18 48.79 9.19",
          endtime: "2025-12-31T23:59:00+01:00",
          schedule: { sunday: "01:00-04:00" },
        },
      ],
    });
    const dstEdgeRecs = sealDrafts(dstEdgeJson);
    const byId = (local: string) =>
      dstEdgeRecs.find((r) => r["id"] === `oc:situation:${SRC.id}:${local}`)!;
    expect((byId("dst-overnight-sat")["validity"] as Record<string, unknown>)["status"]).toBe(
      "unknown",
    );
    expect((byId("dst-end-only-2025")["validity"] as Record<string, unknown>)["status"]).toBe(
      "unknown",
    );
  });
});
