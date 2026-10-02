import type { VehicleClass } from "@openconditions/model";

const VEHICLE_CLASSES: ReadonlyArray<[RegExp, VehicleClass]> = [
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
 * The vehicle classes a set of source vehicle terms names, or null when any
 * term is unknown, negated or carries a comparator ("trucks over 7.5 t"):
 * such a set cannot be narrowed to classes without widening it.
 */
export function vehicleClassesOf(tokens: readonly string[]): VehicleClass[] | null {
  const classes: VehicleClass[] = [];
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
