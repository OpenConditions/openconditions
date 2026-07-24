import { deriveSeverity, type Observation, type Severity } from "@openconditions/core";
import type { RoadEvent, RoadEventType } from "./model.js";

/**
 * Fallback severity per event type, used only when the feed declared no
 * severity AND the impact fields (roadState/lanes) give no signal. Keyed off
 * the canonical {@link RoadEventType} so a newly added type simply stays
 * `unknown` until it is mapped here rather than silently mis-derived. Types
 * with no reliable impact signal (authority, security, equipment_fault,
 * public_event, other) are intentionally absent — left `unknown` rather than
 * fabricated.
 */
const TYPE_SEVERITY: Partial<Record<RoadEventType, Severity>> = {
  road_closure: "high",
  accident: "high",
  lane_closure: "medium",
  contraflow: "medium",
  congestion: "medium",
  hazard: "medium",
  obstruction: "medium",
  detour: "low",
  roadworks: "low",
  broken_down_vehicle: "low",
  weather: "low",
  road_condition: "low",
  speed_restriction: "low",
  dimension_restriction: "low",
  transit_disruption: "low",
};

/** A delay at/above this (seconds) floors an event's severity at "high" — never
 * critical (critical excludes an open road from routing), never a downgrade. */
const DELAY_HIGH_SECONDS = 20 * 60;
const SEVERITY_RANK: Record<Severity, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Returns the same event unless a large delay raises its severity to "high". */
function applyDelayFloor(ev: RoadEvent): RoadEvent {
  const d = ev.delaySeconds;
  if (typeof d !== "number" || d < DELAY_HIGH_SECONDS) return ev;
  if (SEVERITY_RANK[ev.severity] >= SEVERITY_RANK.high) return ev;
  return { ...ev, severity: "high", severitySource: "derived" };
}

/**
 * Post-parse enrichment: when an event carries no declared severity
 * (`severity === "unknown"`), derive one so the map's severity ramp is
 * meaningful for feeds that omit it (e.g. the German Mobilithek roadworks
 * feeds, which render an all-grey blanket otherwise). Tries the impact-based
 * rule first (roadState/lanes, shared with declared-impact feeds via core's
 * {@link deriveSeverity}), then falls back to the event type. Independently,
 * every event (declared or derived) runs {@link applyDelayFloor}: a large
 * Verlustzeit ("delaySeconds") floors severity at "high" — never critical, so a
 * delayed-but-open road is not turned into a Valhalla point exclusion.
 *
 * Declared severities, measurements/flows, and events with neither a resolvable
 * derivation nor a large delay all pass through as the same object reference.
 * Runs uniformly for every feed at the ingest seam, so all present and future
 * road-conditions sources inherit it. The stamped `severitySource: "derived"`
 * keeps the provenance auditable.
 */
export function enrichEventSeverity(observations: Observation[]): Observation[] {
  const out: Observation[] = [];
  for (const obs of observations) {
    if (obs.kind !== "event") {
      out.push(obs);
      continue;
    }
    let ev = obs as RoadEvent;
    if (ev.severity === "unknown") {
      let severity = deriveSeverity({ roadState: ev.roadState, lanesAffected: ev.lanesAffected });
      if (severity === "unknown") severity = TYPE_SEVERITY[ev.type] ?? "unknown";
      if (severity !== "unknown") {
        ev = { ...ev, severity, severitySource: "derived" };
      }
    }
    out.push(applyDelayFloor(ev) as unknown as Observation);
  }
  return out;
}
