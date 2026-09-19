import type { DerivedSeverity, Effect, SeverityRuleInput } from "@openconditions/model";

const RANK: Record<DerivedSeverity, number> = { minor: 1, moderate: 2, major: 3, critical: 4 };

/** A delay of at least this many seconds makes a situation at least major. */
export const DELAY_FLOOR_SECONDS = 20 * 60;

function max(a: DerivedSeverity | undefined, b: DerivedSeverity | undefined) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

function laneSeverity(
  e: Extract<Effect, { kind: "lane_restriction" }>,
): DerivedSeverity | undefined {
  const { lanesTotal, lanesClosed } = e;
  if (lanesTotal !== undefined && lanesClosed !== undefined && lanesClosed > 0) {
    if (lanesClosed >= lanesTotal) return "major";
    return lanesClosed / lanesTotal >= 1 / 3 ? "moderate" : "minor";
  }
  if (e.vehicleImpact === "all_lanes_closed") return "major";
  if (
    e.vehicleImpact.startsWith("some_lanes_closed") ||
    e.vehicleImpact === "alternating_one_way"
  ) {
    return "moderate";
  }
  return undefined;
}

/** What the effects alone say: a closure is major, lanes by the share closed. */
function impactSeverity(effects: readonly Effect[]): DerivedSeverity | undefined {
  let out: DerivedSeverity | undefined;
  for (const e of effects) {
    if (e.kind === "closure") out = max(out, "major");
    else if (e.kind === "lane_restriction") out = max(out, laneSeverity(e));
    else if (e.kind === "contraflow") out = max(out, "moderate");
  }
  return out;
}

function longDelay(effects: readonly Effect[]): boolean {
  return effects.some(
    (e) => e.kind === "delay" && e.delay !== undefined && e.delay.value >= DELAY_FLOOR_SECONDS,
  );
}

/**
 * The roads severity rule, for a situation whose source declares none: the
 * effects decide first (a closure is major; lane closures by the share of
 * lanes closed), then the type's default; a delay of 20 minutes or more
 * raises the result to at least major, never to critical (critical would turn
 * an open road into a routing exclusion). A type without a default and
 * without impact stays unknown rather than being guessed.
 */
export function roadsSeverity(byType: Readonly<Record<string, DerivedSeverity>>) {
  return (s: SeverityRuleInput): DerivedSeverity | undefined => {
    const base = impactSeverity(s.effects) ?? byType[s.type];
    return longDelay(s.effects) ? max(base, "major") : base;
  };
}
