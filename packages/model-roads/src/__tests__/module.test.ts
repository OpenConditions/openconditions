import {
  buildRegistry,
  computeChangeKinds,
  type Effect,
  kernelModule,
  sealRecord,
} from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { ROADS_SOURCE_FORMATS, roadsCrosswalk, roadsModule } from "../module.js";
import { DELAY_FLOOR_SECONDS } from "../severity.js";

const registry = buildRegistry([kernelModule, roadsModule]);

const base = {
  applicability: { kind: "all" },
  compliance: "mandatory",
  normalization: "complete",
  v: 1,
} as const;
const closure = { ...base, id: "R/closure", kind: "closure", scope: "road" } as Effect;
const lanes = (lanesClosed: number, lanesTotal = 3) =>
  ({
    ...base,
    id: "R/lane_restriction",
    kind: "lane_restriction",
    vehicleImpact: "some_lanes_closed",
    lanesClosed,
    lanesTotal,
  }) as Effect;
const delay = (seconds: number) =>
  ({ ...base, id: "R/delay", kind: "delay", delay: { value: seconds, unit: "s" } }) as Effect;

function situation(
  kind: string,
  type: string,
  details: Record<string, unknown>,
  effects: Effect[],
) {
  return {
    id: "oc:situation:nl-ndw-events:SIT-1",
    class: "situation",
    kind,
    type,
    temporality: "live",
    location: {
      geometry: { type: "Point", coordinates: [4.9, 52.37] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
    provenance: {
      origin: "feed",
      sourceId: "nl-ndw-events",
      sourceFormat: "datex2",
      accessMode: "bulk",
      recordId: "SIT-1",
      attribution: { provider: "NDW", license: "CC0-1.0" },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: "2026-09-18T10:00:00Z" },
    planned: false,
    certainty: "observed",
    severity: { label: "unknown" },
    validity: { status: "active", start: "2026-09-18T09:00:00Z" },
    effects,
    details: { kind, v: 1, ...details },
  };
}

const severityOf = (kind: string, type: string, effects: Effect[]) =>
  registry.kind("situation", kind)!.deriveSeverity!({ type, effects });

describe("roads module", () => {
  it("registers the roads domain, fifteen situation kinds and every roads format", () => {
    expect(registry.domains().map((d) => d.code)).toEqual(["roads"]);
    expect(registry.kinds("situation")).toHaveLength(15);
    expect(registry.vocabulary("source_format")!.values).toEqual(
      expect.arrayContaining([...ROADS_SOURCE_FORMATS]),
    );
  });

  it.each([
    ["incident", "accident", {}],
    ["roadworks", "works", { workersPresent: true }],
    ["closure", "closure", {}],
    ["restriction", "dimension", { basis: "temporary" }],
    ["weather_condition", "weather", {}],
    ["road_condition", "surface", { surface: ["unknown"] }],
    ["road_hazard", "hazard", {}],
    ["public_event", "event", {}],
    ["authority", "operation", {}],
    ["equipment_fault", "fault", {}],
    ["security", "incident", {}],
    ["winter_operation", "chain_control", {}],
    ["pass_status", "pass", {}],
    ["congestion", "congestion", { los: "queuing" }],
    ["other", "other", {}],
  ])("seals a %s.%s draft", (kind, type, details) => {
    const sealed = sealRecord(registry, situation(kind, type, details, [closure]), {
      instanceId: "oc.example.org",
      revision: 1,
      recordedAt: "2026-09-18T10:00:01Z",
    });
    expect(sealed.ok ? [] : sealed.issues).toEqual([]);
  });

  it("rejects a congestion without a level of service and a subtype of another type", () => {
    expect(registry.validateDraft(situation("congestion", "congestion", {}, [])).ok).toBe(false);
    const wrong = { ...situation("incident", "breakdown", {}, []), subtype: "overturned" };
    expect(registry.validateDraft(wrong).ok).toBe(false);
  });
});

describe("roads severity rule", () => {
  it("reads the effects before the type default", () => {
    expect(severityOf("roadworks", "works", [closure])).toBe("major");
    expect(severityOf("roadworks", "works", [lanes(3)])).toBe("major");
    expect(severityOf("roadworks", "works", [lanes(1)])).toBe("moderate");
    expect(severityOf("roadworks", "works", [lanes(1, 4)])).toBe("minor");
    expect(severityOf("roadworks", "works", [])).toBe("minor");
  });

  it("raises a long delay to major, never to critical, and does not guess without a signal", () => {
    expect(severityOf("roadworks", "works", [delay(DELAY_FLOOR_SECONDS)])).toBe("major");
    expect(severityOf("incident", "accident", [delay(DELAY_FLOOR_SECONDS)])).toBe("major");
    expect(severityOf("roadworks", "works", [delay(DELAY_FLOOR_SECONDS - 1)])).toBe("minor");
    expect(severityOf("public_event", "event", [])).toBeUndefined();
    expect(severityOf("other", "other", [delay(DELAY_FLOOR_SECONDS)])).toBe("major");
  });
});

describe("lanes_change", () => {
  it("fires when the lane picture changes and not for other effect changes", () => {
    const before = situation("roadworks", "works", {}, [lanes(1)]);
    expect(computeChangeKinds(registry, before, { ...before, effects: [lanes(2)] })).toEqual([
      "effects_change",
      "lanes_change",
    ]);
    expect(
      computeChangeKinds(registry, before, { ...before, effects: [lanes(1), closure] }),
    ).toEqual(["effects_change"]);
  });
});

describe("roads crosswalk", () => {
  it("resolves parsed codes and emitter codes", () => {
    expect(roadsCrosswalk.situation("datex2_v3", "MaintenanceWorks:roadMarkingWork")).toEqual({
      kind: "roadworks",
      type: "works",
      subtype: "line_marking",
    });
    expect(roadsCrosswalk.situation("wzdx", "work-zone:surface-work")?.subtype).toBe("resurfacing");
    expect(roadsCrosswalk.value("cause", "datex2_v2", "poorWeather")).toBe("weather");
    expect(roadsCrosswalk.value("severity", "open511", "MAJOR")).toBe("major");
    expect(
      roadsCrosswalk.situationTargetCode("gtfs_rt", {
        kind: "roadworks",
        type: "works",
        subtype: "maintenance",
      }),
    ).toBe("MAINTENANCE");
  });
});
