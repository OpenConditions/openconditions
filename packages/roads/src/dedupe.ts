import { dedupeObservations } from "@openconditions/core";
import type { Observation } from "@openconditions/core";
import type { RoadEvent } from "./model.js";

export function dedupeRoadEvents(events: RoadEvent[]): RoadEvent[] {
  return dedupeObservations(events as Observation[], {
    sameType: (a, b) => (a as RoadEvent).type === (b as RoadEvent).type,
  }) as RoadEvent[];
}
