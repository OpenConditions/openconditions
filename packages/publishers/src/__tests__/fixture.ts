import type { ConditionEvent, Measurement } from "@openconditions/core";
import type { Geometry } from "geojson";

type RoadFields = {
  roadState?: "open" | "some_lanes_closed" | "single_lane_alternating" | "closed";
  direction?: string;
  roads?: { name: string; ref?: string; roadClass?: string; direction?: string }[];
};

export function roadEvent(
  over: Partial<ConditionEvent> & RoadFields & { geometry?: Geometry } = {}
): ConditionEvent {
  return {
    id: "ndw:1",
    source: "ndw",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "event",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    status: "active",
    origin: {
      kind: "feed",
      attribution: { provider: "NDW", license: "CC0-1.0", url: "https://www.ndw.nu" },
    },
    dataUpdatedAt: "2026-06-22T10:00:00Z",
    fetchedAt: "2026-06-22T10:00:00Z",
    isStale: false,
    type: "accident",
    category: "incident",
    severity: "high",
    severitySource: "derived",
    headline: "Accident on A2",
    ...over,
  } as ConditionEvent;
}

export function measurement(over: Partial<Measurement> = {}): Measurement {
  return {
    id: "flow:1",
    source: "ndw",
    sourceFormat: "datex2",
    domain: "roads",
    kind: "measurement",
    geometry: { type: "Point", coordinates: [13.4, 52.5] },
    status: "active",
    origin: { kind: "feed", attribution: { provider: "NDW", license: "CC0-1.0" } },
    dataUpdatedAt: "2026-06-22T10:00:00Z",
    fetchedAt: "2026-06-22T10:00:00Z",
    isStale: false,
    metric: "flow",
    value: 1200,
    unit: "veh/h",
    aggregation: "live",
    ...over,
  } as Measurement;
}
