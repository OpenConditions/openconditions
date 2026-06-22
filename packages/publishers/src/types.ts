import type { ConditionEvent, Observation } from "@openconditions/core";

/** Feed-level metadata carried by every emitter (foreign members / headers). */
export interface FeedInfo {
  /** Human-readable publisher, e.g. "OpenConditions". */
  attribution?: string;
  /** SPDX or short license id for the aggregate feed. */
  license?: string;
  url?: string;
  /** Generation timestamp (ISO 8601). Pass it in — emitters are pure. */
  timestamp?: string;
}

/** Road-domain fields that live on `RoadEvent` (a `ConditionEvent` subtype). Read
 * defensively so this package depends only on `@openconditions/core`. */
export interface RoadFields {
  roadState?: "open" | "some_lanes_closed" | "single_lane_alternating" | "closed";
  direction?: string;
  roads?: { name: string; ref?: string; roadClass?: string; direction?: string }[];
}

export function isEvent(o: Observation): o is ConditionEvent {
  return o.kind === "event";
}

export function roadFields(o: Observation): RoadFields {
  return o as unknown as RoadFields;
}
