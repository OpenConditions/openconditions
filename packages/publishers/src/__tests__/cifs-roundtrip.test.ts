import { readFileSync } from "node:fs";
import { pinnedOrUnavailable, type SchemaFile, xsdErrors } from "@openconditions/conformance";
import { CIFS_SCHEMA, CIFS_V2 } from "@openconditions/conformance/standards/cifs-v2";
import { buildRegistry, kernelModule, sealRecord } from "@openconditions/model";
import { roadsModule } from "@openconditions/model-roads";
import { parseCifs, type SourceDescriptor, situationDrafts } from "@openconditions/roads";
import { beforeAll, describe, expect, it } from "vitest";
import { situationsToCifsJson, situationsToCifsXml } from "../situation-cifs.js";

const registry = buildRegistry([kernelModule, roadsModule]);

const SRC: SourceDescriptor = {
  id: "de-mobidata-bw-cifs",
  attribution: "MobiData BW",
  country: "DE",
  license: "DL-DE-BY-2.0",
};

const AT = new Date("2026-09-01T10:00:00Z");

function toSealedSituations(raw: string): Record<string, unknown>[] {
  const events = parseCifs(raw, SRC);
  return situationDrafts(events, { source: SRC, fetchedAt: AT.toISOString() }).map((draft) => {
    const sealed = sealRecord(registry, draft, {
      instanceId: "test.local",
      revision: 1,
      recordedAt: AT.toISOString(),
    });
    expect(sealed.ok, sealed.ok ? "" : JSON.stringify(sealed.issues)).toBe(true);
    return sealed.ok ? (sealed.value as Record<string, unknown>) : draft;
  });
}

describe("CIFS round-trip", () => {
  let schemas: SchemaFile[] = [];
  let unavailable: string | undefined;

  beforeAll(async () => {
    const pinned = await pinnedOrUnavailable(CIFS_V2);
    if ("files" in pinned) schemas = pinned.files;
    else unavailable = pinned.unavailable;
  }, 60_000);

  it("round-trips MobiData BW fixture through XML and JSON while preserving semantics", async () => {
    const raw = readFileSync(
      new URL("../../../roads/src/__tests__/fixtures/cifs/mobidata-bw.json", import.meta.url),
      "utf8",
    );
    const pass1 = toSealedSituations(raw);
    expect(pass1).toHaveLength(2);

    const xml = situationsToCifsXml(pass1, AT, { timestamp: AT.toISOString() });
    const json = situationsToCifsJson(pass1, AT, { timestamp: AT.toISOString() });

    if (!unavailable) {
      expect(await xsdErrors(xml, schemas, CIFS_SCHEMA, "mobidata-roundtrip.xml")).toEqual([]);
    }

    const fromXml = toSealedSituations(xml);
    const fromJson = toSealedSituations(JSON.stringify(json));

    expect(fromXml).toHaveLength(2);
    expect(fromJson).toHaveLength(2);

    for (const pass2 of [fromXml, fromJson]) {
      // Record 0: CONSTRUCTION → HAZARD_ON_ROAD_CONSTRUCTION (still roadworks, no closure effect)
      expect(pass2[0]!["kind"]).toBe("roadworks");
      expect(pass2[0]!["effects"]).toEqual([]);
      expect((pass2[0]!["location"] as Record<string, unknown>)["direction"]).toEqual({
        value: "positive",
        basis: "geometry",
      });

      // Record 1: ROAD_CLOSED_CONSTRUCTION → ROAD_CLOSED_CONSTRUCTION (roadworks + complete road closure)
      expect(pass2[1]!["kind"]).toBe("roadworks");
      expect(pass2[1]!["subtype"]).toBe("construction");
      expect(pass2[1]!["effects"]).toEqual([
        expect.objectContaining({ kind: "closure", scope: "road", normalization: "complete" }),
      ]);
      expect((pass2[1]!["location"] as Record<string, unknown>)["direction"]).toEqual({
        value: "both",
        basis: "text",
        text: "BOTH_DIRECTIONS",
      });
    }
  });

  it("round-trips lanes, schedules, and bilateral single-point alerts losslessly", async () => {
    const inputXml = `<?xml version="1.0" encoding="UTF-8"?>
<incidents timestamp="2026-09-01T10:00:00Z">
  <incident id="rt-lanes-1">
    <parent_event id="event-2026"/>
    <updatetime>2026-09-01T09:30:00Z</updatetime>
    <source>
      <reference>ops-1</reference>
      <name>Regional Traffic</name>
    </source>
    <type>HAZARD</type>
    <subtype>HAZARD_ON_ROAD_LANE_CLOSED</subtype>
    <description>Left lane closed</description>
    <street>B10 Stuttgart</street>
    <polyline>48.780000 9.180000 48.790000 9.190000</polyline>
    <direction>ONE_DIRECTION</direction>
    <lanes>
      <lane><order>1</order><type>LANE</type><status>CLOSED</status></lane>
      <lane><order>2</order><type>LANE</type><status>OPEN</status></lane>
    </lanes>
    <starttime>2026-09-01T08:00:00Z</starttime>
    <endtime>2026-09-30T18:00:00Z</endtime>
    <schedule>
      <monday>08:00-12:00</monday>
      <friday>08:00-12:00</friday>
    </schedule>
  </incident>
  <incident id="rt-point-1">
    <type>ACCIDENT</type>
    <subtype>ACCIDENT_MAJOR</subtype>
    <description>Major crash</description>
    <street>A8 Karlsruhe</street>
    <polyline>48.990000 8.400000</polyline>
    <direction>BOTH_DIRECTIONS</direction>
  </incident>
</incidents>`;

    const pass1 = toSealedSituations(inputXml);
    const outXml = situationsToCifsXml(pass1, AT, { timestamp: AT.toISOString() });
    if (!unavailable) {
      expect(await xsdErrors(outXml, schemas, CIFS_SCHEMA, "rt-rich.xml")).toEqual([]);
    }
    const pass2 = toSealedSituations(outXml);
    expect(pass2).toHaveLength(2);
    expect(pass2[0]!["externalIds"]).toContainEqual({
      scheme: "cifs:parent_event",
      id: "event-2026",
    });
    expect((pass2[0]!["effects"] as unknown[])[0]).toMatchObject({
      kind: "lane_restriction",
      lanes: [
        { index: 1, status: "closed" },
        { index: 2, status: "open" },
      ],
    });
    expect((pass2[0]!["validity"] as { periods?: unknown[] }).periods).toEqual([
      expect.objectContaining({
        byDay: ["MO", "FR"],
        startTime: "08:00",
        endTime: "12:00",
        duration: "PT4H",
        scheduleTimezone: "Europe/Berlin",
      }),
    ]);
    expect(pass2[1]!["kind"]).toBe("incident");
    expect(pass2[1]!["type"]).toBe("accident");
    expect((pass2[1]!["severity"] as Record<string, unknown>)["label"]).toBe("major");
    expect((pass2[1]!["location"] as Record<string, unknown>)["geometry"]).toEqual({
      type: "Point",
      coordinates: [8.4, 48.99],
    });
  });
});
