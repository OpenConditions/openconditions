import type { ConditionEvent, Measurement, Observation } from "./model.js";

/**
 * A registered observed property — the soft-validation vocabulary entry for one
 * `${domain}/${type-or-metric}` an observation can carry. This registry is the
 * extensibility guard against attributes-JSONB key sprawl (the documented
 * EAV/JSONB failure mode): as new condition types arrive, they get a row here so
 * a misnamed key (`speedKph` where the model registered `speed_kmh`) or an
 * off-unit measurement is caught as a WARNING at ingest — never a hard failure.
 *
 * A property this registry does not (yet) list still ingests: {@link validateObserved}
 * only warns. The registry describes reality plus the near-term roadmap (§4.8 of
 * the spec), not aspiration — an entry earns its place by an actual or planned
 * observation kind.
 */
export interface ObservedProperty {
  /** `${domain}/${type-or-metric}`, e.g. "roads/accident", "roads/flow", "transit/occupancy". */
  key: string;
  name: string;
  description: string;
  /**
   * Canonical UCUM unit string ("km/h", "Cel", "m") — set on Measurement
   * properties that carry a physical quantity. Enumerated-level measurements
   * (occupancy, busyness, an index) are intentionally unit-less and omit this.
   */
  unit?: string;
  /** Optional QUDT unit URI — a richer-tooling anchor beside the UCUM string. */
  qudtUri?: string;
  /** The attributes-JSONB keys this property is expected to carry, when known. */
  expectedAttributeKeys?: string[];
}

/**
 * Every canonical road-event type. Listed as literal strings (not imported from
 * `@openconditions/roads`) because roads depends on core, never the reverse —
 * so core cannot import it. A cross-check test in `@openconditions/roads`
 * asserts this list stays in lockstep with `ROAD_EVENT_TYPES`; that test is the
 * drift guard.
 */
const ROAD_EVENT_TYPES = [
  "accident",
  "congestion",
  "roadworks",
  "lane_closure",
  "road_closure",
  "contraflow",
  "detour",
  "hazard",
  "weather",
  "road_condition",
  "obstruction",
  "broken_down_vehicle",
  "public_event",
  "authority",
  "speed_restriction",
  "dimension_restriction",
  "equipment_fault",
  "security",
  "transit_disruption",
  "other",
] as const;

/**
 * The attributes-JSONB keys the roads domain's `roadAttributes` mapper can emit
 * for a road EVENT. The mapper is type-agnostic, so every `roads/<event>` entry
 * shares this set. Kept in lockstep with the mapper by the roads cross-check test.
 */
const ROAD_EVENT_ATTRIBUTE_KEYS = [
  "roads",
  "isPlanned",
  "direction",
  "roadState",
  "lanesAffected",
  "speedLimitKph",
  "restrictions",
  "vehiclesAffected",
  "detour",
  "detourGeometry",
  "delaySeconds",
  "queueLengthMeters",
  "workersPresent",
  "workZoneType",
  "regions",
  "relatedEvents",
  "externalRefs",
  "sourceRaw",
  "freeFlowSource",
] as const;

/**
 * The attributes-JSONB keys the roads domain's `roadFlowAttributes` mapper can
 * emit for a `roads/flow` measurement. Kept in lockstep with the mapper by the
 * roads cross-check test.
 */
const ROAD_FLOW_ATTRIBUTE_KEYS = [
  "los",
  "speedKph",
  "freeFlowKph",
  "freeFlowSource",
  "direction",
  "speedRatio",
  "delaySeconds",
  "jamFactor",
] as const;

/** One-line name + description for each road-event type, keyed by the type string. */
const ROAD_EVENT_DESCRIPTIONS: Record<
  (typeof ROAD_EVENT_TYPES)[number],
  { name: string; description: string }
> = {
  accident: { name: "Accident", description: "A traffic accident/collision on the road network." },
  congestion: {
    name: "Congestion",
    description:
      "Abnormally slow or queuing traffic; either feed-declared or derived when a roads/flow measurement crosses the queuing level-of-service threshold.",
  },
  roadworks: {
    name: "Roadworks",
    description: "Planned or active road construction/maintenance works.",
  },
  lane_closure: {
    name: "Lane closure",
    description: "One or more lanes closed while the carriageway stays partially open.",
  },
  road_closure: {
    name: "Road closure",
    description: "The full carriageway is closed to traffic.",
  },
  contraflow: {
    name: "Contraflow",
    description:
      "Traffic routed against the normal flow direction (e.g. a contraflow through works).",
  },
  detour: {
    name: "Detour",
    description: "A signed diversion/alternative route around a condition.",
  },
  hazard: {
    name: "Hazard",
    description:
      "A hazard on or beside the carriageway (debris, animals, spillage, flooding, wildfire and other natural events).",
  },
  weather: {
    name: "Weather",
    description: "A weather condition affecting the road (ice, snow, fog, high wind, heavy rain).",
  },
  road_condition: {
    name: "Road condition",
    description:
      "Road-surface condition (slippery, poor grip, standing water), distinct from the weather causing it.",
  },
  obstruction: {
    name: "Obstruction",
    description: "An object or vehicle obstructing the carriageway.",
  },
  broken_down_vehicle: {
    name: "Broken-down vehicle",
    description: "A broken-down or disabled vehicle affecting traffic.",
  },
  public_event: {
    name: "Public event",
    description: "A public event (parade, demonstration, sporting event) impacting the road.",
  },
  authority: {
    name: "Authority",
    description:
      "An authority/enforcement presence (police checkpoint, control) affecting traffic.",
  },
  speed_restriction: {
    name: "Speed restriction",
    description: "A temporary speed restriction/limit.",
  },
  dimension_restriction: {
    name: "Dimension restriction",
    description: "A temporary dimension restriction (height/width/weight/length).",
  },
  equipment_fault: {
    name: "Equipment fault",
    description:
      "A roadside-equipment fault (signals, tunnel systems, lighting, elevator/lift) affecting traffic; the road-domain home for infrastructure/accessibility equipment failures.",
  },
  security: {
    name: "Security",
    description: "A security-related incident or alert affecting the road.",
  },
  transit_disruption: {
    name: "Transit disruption (road-side)",
    description:
      "A road-side disruption to public transport (e.g. a blocked bus lane or tram route) carried in the roads domain; distinct from the transit-domain transit/disruption service alert.",
  },
  other: {
    name: "Other",
    description:
      "A condition that maps to no specific road-event type (extensible-enum fallthrough).",
  },
};

/** Recursively freeze an object graph so the seeded registry cannot be mutated. */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    for (const name of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[name]);
    }
    Object.freeze(value);
  }
  return value;
}

function buildRegistry(): Record<string, ObservedProperty> {
  const entries: ObservedProperty[] = [];

  for (const type of ROAD_EVENT_TYPES) {
    const { name, description } = ROAD_EVENT_DESCRIPTIONS[type];
    entries.push({
      key: `roads/${type}`,
      name,
      description,
      expectedAttributeKeys: [...ROAD_EVENT_ATTRIBUTE_KEYS],
    });
  }

  entries.push({
    key: "roads/flow",
    name: "Road traffic flow",
    description:
      "Live traffic-flow measurement for a road segment: level-of-service plus optional speed, free-flow baseline, speed ratio, delay and jam factor. The speed value is in km/h.",
    unit: "km/h",
    qudtUri: "http://qudt.org/vocab/unit/KiloM-PER-HR",
    expectedAttributeKeys: [...ROAD_FLOW_ATTRIBUTE_KEYS],
  });

  entries.push({
    key: "roads/temperature",
    name: "Road/air temperature",
    description:
      "Road-surface or roadside air temperature (weather-station or road-weather-sensor reading), in degrees Celsius.",
    unit: "Cel",
    qudtUri: "http://qudt.org/vocab/unit/DEG_C",
  });

  entries.push({
    key: "transit/occupancy",
    name: "Transit vehicle occupancy",
    description:
      "How full a public-transport vehicle/trip is. Unit-less: the level is the GTFS-RT OccupancyStatus enum " +
      "(EMPTY, MANY_SEATS_AVAILABLE, FEW_SEATS_AVAILABLE, STANDING_ROOM_ONLY, CRUSHED_STANDING_ROOM_ONLY, FULL, " +
      "NOT_ACCEPTING_PASSENGERS, NO_DATA_AVAILABLE, NOT_BOARDABLE) — the existing standard vocabulary, not a new one.",
  });

  entries.push({
    key: "transit/temperature",
    name: "In-vehicle temperature",
    description:
      "In-vehicle (cabin) temperature for a transit trip, in degrees Celsius. There is no standard field for this " +
      "in GTFS-RT or SIRI, so it is attributes-resident by design (carried in the observation attributes, not a typed column).",
    unit: "Cel",
    qudtUri: "http://qudt.org/vocab/unit/DEG_C",
  });

  entries.push({
    key: "transit/disruption",
    name: "Transit service alert",
    description:
      "A public-transport service disruption/alert (GTFS-RT service alerts) affecting a route, stop or trip — the transit-domain counterpart to the road-side roads/transit_disruption event.",
  });

  entries.push({
    key: "places/busyness",
    name: "Place busyness",
    description:
      'How busy a place is, as a unit-less relative level (live, or aggregation:"typical" for popular-times).',
  });

  entries.push({
    key: "environment/water_level",
    name: "Water level",
    description:
      "Water/flood level at a station or segment (river gauge, tide, flood sensor), in metres.",
    unit: "m",
    qudtUri: "http://qudt.org/vocab/unit/M",
  });

  entries.push({
    key: "environment/air_quality",
    name: "Air quality index",
    description:
      "Air-quality index (AQI) at a location/station. Unit-less: an index value, not a physical concentration.",
  });

  entries.push({
    key: "environment/noise",
    name: "Noise level",
    description: "Ambient noise level at a location/station, in decibels.",
    unit: "dB",
    qudtUri: "http://qudt.org/vocab/unit/DeciB",
  });

  entries.push({
    key: "border/wait_time",
    name: "Border/crossing wait time",
    description: "Wait time at a border crossing or checkpoint, in minutes.",
    unit: "min",
    qudtUri: "http://qudt.org/vocab/unit/MIN",
  });

  const registry: Record<string, ObservedProperty> = {};
  for (const entry of entries) {
    registry[entry.key] = entry;
  }
  return registry;
}

/**
 * The seeded, deep-frozen ObservedProperty registry, keyed by
 * `${domain}/${type-or-metric}`. Frozen so a caller cannot mutate the shared
 * vocabulary at runtime.
 */
export const OBSERVED_PROPERTIES: Record<string, ObservedProperty> = deepFreeze(buildRegistry());

/**
 * The registry key an observation validates against:
 * `${domain}/${event-type-or-measurement-metric}`.
 */
export function observedKey(obs: Observation): string {
  const suffix = obs.kind === "event" ? (obs as ConditionEvent).type : (obs as Measurement).metric;
  return `${obs.domain}/${suffix}`;
}

const REGISTRY_HINT = "see packages/core/src/observed-properties.ts";

/**
 * Soft-validate an observation against the {@link OBSERVED_PROPERTIES} registry.
 * NEVER throws and NEVER mutates — it only reports warnings, so an unknown type
 * still ingests. Returns `{ warnings: [] }` on clean input.
 *
 * Warns when:
 *  - the observation's `${domain}/${type-or-metric}` key is not registered;
 *  - a registered property defines `expectedAttributeKeys` and the observation's
 *    `attributes` bag carries keys outside that set (the sprawl guard — a
 *    misnamed `speedKph` vs a registered `speed_kmh` surfaces here). Missing
 *    expected keys are NOT warned: sparse data is normal.
 *  - a measurement's `unit` differs from the registry's canonical unit.
 */
export function validateObserved(obs: Observation): { warnings: string[] } {
  const warnings: string[] = [];
  const key = observedKey(obs);
  const entry = OBSERVED_PROPERTIES[key];

  if (entry === undefined) {
    warnings.push(`observation carries unregistered observed property "${key}" — ${REGISTRY_HINT}`);
    return { warnings };
  }

  if (entry.expectedAttributeKeys !== undefined) {
    const attributes = (obs as { attributes?: unknown }).attributes;
    if (attributes !== null && typeof attributes === "object" && !Array.isArray(attributes)) {
      const expected = new Set(entry.expectedAttributeKeys);
      const unexpected = Object.keys(attributes as Record<string, unknown>).filter(
        (k) => !expected.has(k)
      );
      if (unexpected.length > 0) {
        warnings.push(
          `observed property "${key}" carries unexpected attribute key(s) [${unexpected.join(", ")}] ` +
            `not in its registered expectedAttributeKeys — ${REGISTRY_HINT}`
        );
      }
    }
  }

  if (obs.kind === "measurement" && entry.unit !== undefined) {
    const unit = (obs as Measurement).unit;
    if (unit != null && unit !== entry.unit) {
      warnings.push(
        `observed property "${key}" measurement carries unit "${unit}" but the registry expects ` +
          `"${entry.unit}" — ${REGISTRY_HINT}`
      );
    }
  }

  return { warnings };
}
