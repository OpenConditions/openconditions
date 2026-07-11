import { describe, expect, it } from "vitest";
import type { ConditionEvent, Measurement, Observation } from "../model.js";
import {
  OBSERVED_PROPERTIES,
  observedKey,
  validateObserved,
  type ObservedProperty,
} from "../observed-properties.js";

/** Measurement properties that are intentionally unit-less (enumerated level / index). */
const UNITLESS_MEASUREMENTS = ["transit/occupancy", "places/busyness", "environment/air_quality"];

function baseEvent(overrides: Partial<ConditionEvent> = {}): ConditionEvent {
  return {
    id: "src:1",
    source: "src",
    sourceFormat: "geojson",
    domain: "roads",
    kind: "event",
    type: "accident",
    category: "incident",
    severity: "high",
    severitySource: "declared",
    headline: "H",
    status: "active",
    geometry: { type: "Point", coordinates: [4, 52] },
    origin: { kind: "feed", attribution: { provider: "P", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-07-01T10:00:00Z",
    fetchedAt: "2026-07-01T10:00:00Z",
    isStale: false,
    ...overrides,
  } as ConditionEvent;
}

function baseMeasurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    id: "src:m1",
    source: "src",
    sourceFormat: "native",
    domain: "roads",
    kind: "measurement",
    metric: "flow",
    aggregation: "live",
    geometry: { type: "Point", coordinates: [4, 52] },
    status: "active",
    origin: { kind: "feed", attribution: { provider: "P", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-07-01T10:00:00Z",
    fetchedAt: "2026-07-01T10:00:00Z",
    isStale: false,
    ...overrides,
  } as Measurement;
}

describe("OBSERVED_PROPERTIES registry", () => {
  it("keys every entry by its own key field", () => {
    for (const [key, entry] of Object.entries(OBSERVED_PROPERTIES)) {
      expect(entry.key).toBe(key);
    }
  });

  it("registers roads/flow and the named future-domain properties", () => {
    expect(OBSERVED_PROPERTIES["roads/flow"]).toBeDefined();
    expect(OBSERVED_PROPERTIES["transit/occupancy"]).toBeDefined();
    expect(OBSERVED_PROPERTIES["transit/temperature"]).toBeDefined();
    expect(OBSERVED_PROPERTIES["transit/disruption"]).toBeDefined();
    expect(OBSERVED_PROPERTIES["places/busyness"]).toBeDefined();
    expect(OBSERVED_PROPERTIES["environment/water_level"]).toBeDefined();
  });

  it("names the GTFS-RT OccupancyStatus vocabulary in transit/occupancy", () => {
    const occ = OBSERVED_PROPERTIES["transit/occupancy"];
    expect(occ?.unit).toBeUndefined();
    expect(occ?.description).toContain("OccupancyStatus");
    expect(occ?.description).toContain("STANDING_ROOM_ONLY");
  });

  it("gives every physical-quantity measurement a canonical UCUM unit", () => {
    const physicalMeasurements: Record<string, string> = {
      "roads/flow": "km/h",
      "roads/temperature": "Cel",
      "transit/temperature": "Cel",
      "environment/water_level": "m",
      "environment/noise": "dB",
      "border/wait_time": "min",
    };
    for (const [key, unit] of Object.entries(physicalMeasurements)) {
      const entry = OBSERVED_PROPERTIES[key];
      expect(entry, key).toBeDefined();
      expect(entry?.unit, key).toBe(unit);
    }
  });

  it("marks occupancy/busyness/air-quality as intentionally unit-less", () => {
    for (const key of UNITLESS_MEASUREMENTS) {
      expect(OBSERVED_PROPERTIES[key]?.unit, key).toBeUndefined();
    }
  });

  it("is deep-frozen: the registry, its entries, and nested arrays are immutable", () => {
    expect(Object.isFrozen(OBSERVED_PROPERTIES)).toBe(true);
    for (const entry of Object.values(OBSERVED_PROPERTIES)) {
      expect(Object.isFrozen(entry)).toBe(true);
      if (entry.expectedAttributeKeys) {
        expect(Object.isFrozen(entry.expectedAttributeKeys)).toBe(true);
      }
    }
  });

  it("silently no-ops (or throws in strict mode) on mutation attempts", () => {
    const attempt = () => {
      (OBSERVED_PROPERTIES as Record<string, ObservedProperty>)["roads/flow"] = {
        key: "x",
        name: "x",
        description: "x",
      };
    };
    // A frozen object rejects the write; whether it throws (strict) or no-ops,
    // the registry must be unchanged afterwards.
    try {
      attempt();
    } catch {
      /* strict-mode TypeError is acceptable */
    }
    expect(OBSERVED_PROPERTIES["roads/flow"]?.name).toBe("Road traffic flow");
  });
});

describe("observedKey", () => {
  it("keys an event by domain/type", () => {
    expect(observedKey(baseEvent({ type: "roadworks" }))).toBe("roads/roadworks");
  });

  it("keys a measurement by domain/metric", () => {
    expect(observedKey(baseMeasurement({ metric: "flow" }))).toBe("roads/flow");
  });
});

describe("validateObserved", () => {
  it("returns no warnings for a known event", () => {
    expect(validateObserved(baseEvent({ type: "accident" })).warnings).toEqual([]);
  });

  it("returns no warnings for a known measurement with matching unit", () => {
    expect(validateObserved(baseMeasurement({ metric: "flow", unit: "km/h" })).warnings).toEqual(
      []
    );
  });

  it("warns exactly once for an unknown key, naming key and registry file", () => {
    const { warnings } = validateObserved(baseEvent({ type: "meteor_strike" }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("roads/meteor_strike");
    expect(warnings[0]).toContain("observed-properties.ts");
  });

  it("warns listing unexpected attribute keys (the sprawl guard)", () => {
    const obs = baseMeasurement({ metric: "flow", unit: "km/h" }) as Measurement & {
      attributes: Record<string, unknown>;
    };
    obs.attributes = { los: "heavy", speedKph: 40, speedKmh: 40 };
    const { warnings } = validateObserved(obs);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("speedKmh");
    expect(warnings[0]).not.toContain("los");
  });

  it("does not warn about missing expected attribute keys (sparse data is normal)", () => {
    const obs = baseMeasurement({ metric: "flow", unit: "km/h" }) as Measurement & {
      attributes: Record<string, unknown>;
    };
    obs.attributes = { los: "heavy" };
    expect(validateObserved(obs).warnings).toEqual([]);
  });

  it("warns on a unit mismatch for a known measurement", () => {
    const { warnings } = validateObserved(baseMeasurement({ metric: "flow", unit: "mph" }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("mph");
    expect(warnings[0]).toContain("km/h");
  });

  it("never throws and never mutates the input", () => {
    const obs = baseEvent({ type: "accident" });
    const snapshot = JSON.stringify(obs);
    expect(() => validateObserved(obs)).not.toThrow();
    expect(JSON.stringify(obs)).toBe(snapshot);
  });

  it("tolerates an event missing its type without throwing", () => {
    const obs = baseEvent();
    delete (obs as Partial<ConditionEvent>).type;
    const { warnings } = validateObserved(obs as Observation);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("roads/undefined");
  });
});
