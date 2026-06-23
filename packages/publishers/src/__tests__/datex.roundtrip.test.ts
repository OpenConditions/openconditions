import { parseDatexSituations, type SourceDescriptor } from "@openconditions/roads";
import { describe, expect, it } from "vitest";
import { observationsToDatexSituations } from "../datex.js";
import { roadEvent } from "./fixture.js";

/**
 * The real interop proof: emit DATEX II, then re-ingest it with our own DATEX
 * parser. If a third party (an EU NAP) can read what we emit, so can our reader.
 */

const SRC: SourceDescriptor = {
  id: "rt",
  attribution: "OpenConditions",
  country: "de",
  license: "CC0-1.0",
  licenseUrl: "https://openconditions.org",
};

describe("DATEX II round-trip through the ingest parser", () => {
  it("recovers an accident's type, geometry, severity, validity and headline", () => {
    const xml = observationsToDatexSituations([
      roadEvent({
        id: "ndw:rt1",
        type: "accident",
        severity: "high",
        headline: "Accident on A2",
        geometry: { type: "Point", coordinates: [13.4, 52.5] },
        roads: [{ name: "A2", ref: "A2" }],
        validFrom: "2026-06-23T08:00:00Z",
        validTo: "2026-06-23T12:00:00Z",
      }),
    ]);

    const [ev] = parseDatexSituations(xml, SRC);
    expect(ev).toBeDefined();
    expect(ev!.type).toBe("accident");
    expect(ev!.geometry).toEqual({ type: "Point", coordinates: [13.4, 52.5] });
    expect(ev!.severity).toBe("high");
    expect(ev!.headline).toBe("Accident on A2");
    expect(ev!.roads[0]?.ref).toBe("A2");
    expect(ev!.validFrom).toBe("2026-06-23T08:00:00Z");
    expect(ev!.validTo).toBe("2026-06-23T12:00:00Z");
  });

  it("re-ingests a closure as a management record with a closed road state", () => {
    const xml = observationsToDatexSituations([
      roadEvent({ id: "ndw:rt2", type: "road_closure", roadState: "closed" }),
    ]);
    const [ev] = parseDatexSituations(xml, SRC);
    expect(ev).toBeDefined();
    expect(ev!.type).toBe("lane_closure"); // DATEX models closures as management records
    expect(ev!.roadState).toBe("closed");
  });

  it("round-trips cause, impact, speed, detour, vehicles, queue, TMC and confidence", () => {
    const xml = observationsToDatexSituations([
      roadEvent({
        id: "ndw:rt3",
        type: "roadworks",
        subtype: "roadMaintenance",
        confidence: "likely",
        lanesAffected: { total: 3, closed: 1 },
        delaySeconds: 600,
        speedLimitKph: 50,
        detour: "Use A4",
        vehiclesAffected: ["lorry"],
        restrictions: [{ type: "height", value: 4.5, unit: "m" }],
        queueLengthMeters: 1200,
        externalRefs: { tmc: { country: "8", table: 6.13, code: 7324 } },
        roads: [{ name: "A2" }],
      }),
    ]);
    const [ev] = parseDatexSituations(xml, SRC);
    expect(ev).toBeDefined();
    expect(ev!.subtype).toBe("roadMaintenance"); // cause>causeType
    expect(ev!.lanesAffected?.closed).toBe(1);
    expect(ev!.lanesAffected?.total).toBe(3);
    expect(ev!.delaySeconds).toBe(600);
    expect(ev!.speedLimitKph).toBe(50);
    expect(ev!.detour).toBe("Use A4");
    expect(ev!.vehiclesAffected).toContain("lorry");
    expect(ev!.restrictions).toContainEqual({ type: "height", value: 4.5, unit: "m" });
    expect(ev!.queueLengthMeters).toBe(1200);
    expect(ev!.externalRefs?.tmc?.code).toBe(7324);
    expect(ev!.confidence).toBe("likely");
  });
});
