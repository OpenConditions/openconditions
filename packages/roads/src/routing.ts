import type { CanonicalVehicleClass, RoutingApplicability } from "@openconditions/core";
import { hasRestrictionEvidence, type RestrictionCarrier } from "@openconditions/model-roads";
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
 * The canonical classes a set of source vehicle terms names, or null when any
 * term is unknown, negated or carries a comparator ("trucks over 7.5 t"):
 * such a set cannot be narrowed to classes without widening it.
 */
export function vehicleClassesOf(tokens: readonly string[]): CanonicalVehicleClass[] | null {
  const classes: CanonicalVehicleClass[] = [];
  for (const token of tokens) {
    if (/\b(?:except|excluding|not|other than|only if|greater|less|above|below)\b/i.test(token)) {
      return null;
    }
    const mapped = VEHICLE_CLASSES.find(([pattern]) => pattern.test(compact(token)))?.[1];
    if (!mapped) return null;
    if (!classes.includes(mapped)) classes.push(mapped);
  }
  return classes;
}

/**
 * Converts source vehicle terms to the deliberately small routing vocabulary.
 * Unknown, negated and comparator-bearing predicates stay unknown; widening
 * one of those predicates to all traffic would turn a class restriction into
 * a global graph effect.
 *
 * `carrier` is the optional observation/attributes bag carrying the normalized
 * restriction contract. Existing two-argument callers keep their behaviour.
 */
export function normalizeVehicleApplicability(
  raw: string[] | undefined,
  restrictions?: Restriction[],
  carrier?: RestrictionCarrier,
): RoutingApplicability {
  // Any normalized restriction evidence — valid, partial or unparseable — is
  // an independent exclusion. Checked before the legacy array so dropping that
  // array can never turn a vehicle-specific record into all-vehicle evidence.
  if (carrier && hasRestrictionEvidence(carrier)) {
    return { kind: "unknown", raw: ["normalized_restriction_details"] };
  }
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
  const classes = vehicleClassesOf(source);
  return classes === null
    ? { kind: "unknown", raw: source }
    : { kind: "classes", classes, raw: source };
}
