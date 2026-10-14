import { buildRegistry, kernelModule, observationId } from "@openconditions/model";
import { describe, expect, it } from "vitest";
import { vehiclesModule } from "../module.js";

const registry = buildRegistry([kernelModule, vehiclesModule]);

describe("vehicles module", () => {
  it("registers service vehicles and their positions", () => {
    expect(registry.kind("feature", "service_vehicle")?.domain).toBe("vehicles");
    expect(registry.property("vehicle.position")?.retention).toEqual({ rawDays: 2 });
    expect(registry.property("vehicle.position")?.transient).toBe(true);
  });

  it("validates a position report and keeps speeds in km/h", () => {
    const draft = {
      class: "observation",
      kind: "observation",
      property: "vehicle.position",
      temporality: "live",
      location: {
        geometry: { type: "Point", coordinates: [-93.57, 42.42] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      provenance: {
        origin: "feed",
        sourceId: "us-ia-dot-avl",
        sourceFormat: "derived",
        accessMode: "bulk",
        recordId: "A35674",
        attribution: { provider: "Iowa DOT", license: "public-domain" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: "2026-09-19T15:00:00Z" },
      subject: { kind: "feature", featureId: "oc:feature:us-ia-dot-avl:A35674" },
      result: {
        type: "structured",
        schema: "vehicle_position",
        v: 1,
        value: {
          v: 1,
          point: { type: "Point", coordinates: [-93.57, 42.42] },
          bearingDeg: 179,
          speed: { value: 106, unit: "km/h" },
        },
      },
      phenomenonTime: { instant: "2026-09-19T14:59:21Z" },
      aggregation: "instantaneous",
    };
    const named = { ...draft, id: observationId("us-ia-dot-avl", draft as never) };
    expect(registry.validateDraft(named)).toMatchObject({ ok: true });
    const mph = structuredClone(named);
    mph.result.value.speed = { value: 65.9, unit: "[mi_i]/h" };
    expect(registry.validateDraft(mph)).toMatchObject({ ok: false });
  });

  it("takes an anonymous position at its location, and no other subject", () => {
    const draft = {
      class: "observation",
      kind: "observation",
      property: "vehicle.position",
      temporality: "live",
      location: {
        geometry: { type: "Point", coordinates: [25.5078, 65.0172] },
        extent: "point",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
      provenance: {
        origin: "feed",
        sourceId: "fi-digitraffic-maintenance",
        sourceFormat: "geojson",
        accessMode: "bulk",
        recordId: "202635031",
        attribution: { provider: "Fintraffic", license: "CC-BY-4.0" },
        privacy: { class: "authoritative" },
      },
      freshness: { fetchedAt: "2026-10-14T23:24:56Z", expiresAt: "2026-10-14T23:30:57Z" },
      subject: { kind: "location" },
      result: {
        type: "structured",
        schema: "vehicle_position",
        v: 1,
        value: {
          v: 1,
          point: { type: "Point", coordinates: [25.5078, 65.0172] },
          activity: "plowing",
          plowUp: false,
        },
      },
      phenomenonTime: { instant: "2026-10-14T23:20:57Z" },
      aggregation: "instantaneous",
    };
    const named = { ...draft, id: observationId("fi-digitraffic-maintenance", draft as never) };
    expect(registry.validateDraft(named)).toMatchObject({ ok: true });
    const onSituation = {
      ...named,
      subject: { kind: "situation", situationId: "oc:situation:x:1" },
    };
    expect(registry.validateDraft(onSituation)).toMatchObject({ ok: false });
  });
});
