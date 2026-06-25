import { dedupeObservations } from "@openconditions/core";
import type { Observation } from "@openconditions/core";
import type { RoadEvent } from "./model.js";

export function dedupeRoadEvents(events: RoadEvent[]): RoadEvent[] {
  return dedupeObservations(events as Observation[], {
    sameType: (a, b) => (a as RoadEvent).type === (b as RoadEvent).type,
    // Road events carry their text in `headline`, not `label`; point the
    // similarity guard at it so two unrelated same-type works at one coordinate
    // are not merged just because they are co-located.
    textOf: (o) => (o as RoadEvent).headline ?? o.label,
  }) as RoadEvent[];
}
