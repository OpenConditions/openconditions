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

/**
 * Post-parse enrichment: when an event carries no declared severity
 * (`severity === "unknown"`), derive one so the map's severity ramp is
 * meaningful for feeds that omit it (e.g. the German Mobilithek roadworks
 * feeds, which render an all-grey blanket otherwise). Tries the impact-based
 * rule first (roadState/lanes, shared with declared-impact feeds via core's
 * {@link deriveSeverity}), then falls back to the event type.
 *
 * Declared severities, measurements/flows, and events whose type carries no
 * signal all pass through untouched. Runs uniformly for every feed at the
 * ingest seam, so all present and future road-conditions sources inherit it.
 * The stamped `severitySource: "derived"` keeps the provenance auditable.
 */
export function enrichEventSeverity(observations: Observation[]): Observation[] {
  const out: Observation[] = [];
  for (const obs of observations) {
    if (obs.kind !== "event" || (obs as RoadEvent).severity !== "unknown") {
      out.push(obs);
      continue;
    }
    const ev = obs as RoadEvent;
    let severity = deriveSeverity({ roadState: ev.roadState, lanesAffected: ev.lanesAffected });
    if (severity === "unknown") severity = TYPE_SEVERITY[ev.type] ?? "unknown";
    if (severity === "unknown") {
      out.push(obs);
      continue;
    }
    out.push({ ...ev, severity, severitySource: "derived" } as unknown as Observation);
  }
  return out;
}
