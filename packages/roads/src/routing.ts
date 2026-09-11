import type { CanonicalVehicleClass, RoutingApplicability } from "@openconditions/core";
import type { Restriction } from "./model.js";

const VEHICLE_CLASSES: ReadonlyArray<[RegExp, CanonicalVehicleClass]> = [
  [/^(?:motorvehicle|motor_vehicle|allmotorvehicles)$/i, "motor_vehicle"],
  [/^(?:car|cars|passengercar|passengervehicle)$/i, "car"],
  [/^(?:truck|trucks|lorry|lorries|heavygoodsvehicle|goodsvehicle)$/i, "truck"],
  [/^(?:bus|buses|publictransport)$/i, "bus"],
  [/^(?:motorcycle|motorcycles|motorbike)$/i, "motorcycle"],
  [/^(?:bicycle|bicycles|bike)$/i, "bicycle"],
  [/^(?:pedestrian|pedestrians|foot)$/i, "pedestrian"],
];

function compact(value: string): string {
  return value.trim().replace(/[\s_-]+/g, "");
}

/**
 * Converts source vehicle terms to the deliberately small routing vocabulary.
 * Unknown, negated and comparator-bearing predicates stay unknown; widening
 * one of those predicates to all traffic would turn a class restriction into
 * a global graph effect.
 */
export function normalizeVehicleApplicability(
  raw: string[] | undefined,
  restrictions?: Restriction[]
): RoutingApplicability {
  if (restrictions && restrictions.length > 0) {
    return {
      kind: "unknown",
      raw: [
        ...(raw ?? []),
        ...restrictions.map((restriction) => JSON.stringify(restriction.raw ?? restriction)),
      ],
    };
  }
  if (!raw || raw.length === 0) return { kind: "all" };
  const source = raw.filter((value) => typeof value === "string" && value.trim().length > 0);
  if (source.length === 0) return { kind: "unknown", raw: [] };
  const classes: CanonicalVehicleClass[] = [];
  for (const token of source) {
    if (/\b(?:except|excluding|not|other than|only if|greater|less|above|below)\b/i.test(token)) {
      return { kind: "unknown", raw: source };
    }
    const normalized = compact(token);
    const mapped = VEHICLE_CLASSES.find(([pattern]) => pattern.test(normalized))?.[1];
    if (!mapped) return { kind: "unknown", raw: source };
    if (!classes.includes(mapped)) classes.push(mapped);
  }
  return { kind: "classes", classes, raw: source };
}
