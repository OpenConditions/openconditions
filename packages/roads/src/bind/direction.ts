/**
 * The direction of travel a bound location applies to, read from the
 * directions a record states: its location's and, more specific where it
 * says something, the effect's own. Pure: model directions in, a statement
 * the resolver can hold against the geometry out.
 */

/**
 * What a stated direction says about the geometry it is bound with:
 *
 * - `along`: the direction the geometry is drawn in, first coordinate to last.
 * - `against`: the opposite of the direction the location itself states, or
 *   of the geometry's order. The geometry does not run that way, so it cannot
 *   place it.
 * - `one`: a single direction along an axis (road reference, Alert-C,
 *   OpenLR) the geometry does not carry. A drawn line is taken to run in it,
 *   as it always has been; a point cannot tell which way it is.
 * - `heading`: a compass point or bearing, held against each carriageway's
 *   own heading.
 * - `unplaced`: a single direction along an axis nobody identified (basis
 *   `unknown`), such as a DATEX measure `aligned` with or `opposite` to a
 *   location that states no direction to be aligned with. No geometry can
 *   tell which carriageway it is, a drawn line included.
 */
export type TravelDirection =
  | { kind: "along" }
  | { kind: "against" }
  | { kind: "one" }
  | { kind: "unplaced" }
  | { kind: "heading"; bearingDeg: number };

/** A model `DirectionRef` as stored, read defensively: any field may be missing or malformed. */
export interface StatedDirection {
  value?: unknown;
  basis?: unknown;
  compass?: unknown;
  bearingDeg?: unknown;
  /** The rest of the direction (its text, a loop) says nothing the resolver can use. */
  [field: string]: unknown;
}

const COMPASS_DEG: Readonly<Record<string, number>> = {
  N: 0,
  NE: 45,
  E: 90,
  SE: 135,
  S: 180,
  SW: 225,
  W: 270,
  NW: 315,
};

function headingOf(d: StatedDirection): number | undefined {
  if (d.basis === "compass" && typeof d.compass === "string") {
    return Object.hasOwn(COMPASS_DEG, d.compass) ? COMPASS_DEG[d.compass] : undefined;
  }
  if (d.basis === "bearing" && typeof d.bearingDeg === "number" && Number.isFinite(d.bearingDeg)) {
    return ((d.bearingDeg % 360) + 360) % 360;
  }
  return undefined;
}

const onAxis = (d: StatedDirection | undefined): d is StatedDirection =>
  d !== undefined && (d.value === "positive" || d.value === "negative");

/**
 * Whether a direction says anything about where traffic is affected: both
 * ways, one way along an axis, or a heading. An unknown or text-only
 * direction, a ring road's loop and a direction left unparsed say nothing.
 */
function informative(d: StatedDirection | undefined): d is StatedDirection {
  return d !== undefined && (d.value === "both" || onAxis(d) || headingOf(d) !== undefined);
}

function fromStated(d: StatedDirection | undefined): TravelDirection | undefined {
  if (!informative(d) || d.value === "both") return undefined;
  const heading = headingOf(d);
  if (heading !== undefined) return { kind: "heading", bearingDeg: heading };
  if (d.basis === "geometry") return { kind: d.value === "positive" ? "along" : "against" };
  if (d.basis === "unknown") return { kind: "unplaced" };
  return { kind: "one" };
}

/**
 * The direction one bound location applies to. An effect's own direction is
 * the more specific statement and replaces its location's, unless it says
 * nothing (unknown, text only), in which case the location's stands. An
 * effect on the opposite side of the axis its one-directional location
 * states is `against` it; two directions on an unidentified axis cannot be
 * compared. `undefined` means nothing narrows the binding: no direction, both
 * directions, or none the resolver can relate to a road.
 */
export function travelDirectionOf(
  location: StatedDirection | undefined,
  effect?: StatedDirection,
): TravelDirection | undefined {
  if (!informative(effect)) return fromStated(location);
  if (
    onAxis(effect) &&
    onAxis(location) &&
    effect.basis !== "unknown" &&
    effect.basis === location.basis &&
    effect.value !== location.value
  ) {
    return { kind: "against" };
  }
  return fromStated(effect);
}
