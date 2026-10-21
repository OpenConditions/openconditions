import { isValidityInEffectAt, nextScheduleTransition } from "../schedule/in-effect.js";
import type { Effect } from "./effect-type.js";
import type { Validity } from "./validity.js";

export type EffectState = "active" | "scheduled" | "ended" | "unknown";

/** Issue codes that leave an effect's time window unknown. */
const TEMPORAL_ISSUES = new Set(["invalid_window", "unsupported_schedule", "unsupported_status"]);

/** The validity an effect is evaluated against: its own, else its situation's. */
export function effectValidity(effect: Pick<Effect, "validity">, situation: Validity): Validity {
  return effect.validity ?? situation;
}

/**
 * The earliest of some instants, in UTC. One past the year 9999 in UTC (an
 * open-ended `9999-12-31T23:59:59-05:00`) has no RFC 3339 form there, so it
 * keeps the form it was written in.
 */
function earliest(instants: (string | null | undefined)[]): string | null {
  let best: { t: number; value: string } | null = null;
  for (const value of instants) {
    if (value == null) continue;
    const t = Date.parse(value);
    if (Number.isFinite(t) && (best === null || t < best.t)) best = { t, value };
  }
  if (best === null) return null;
  const utc = new Date(best.t).toISOString();
  return /^\d{4}-/.test(utc) ? utc : best.value;
}

/**
 * The state of an effect at `at`, evaluated at the edge and never stored:
 * `ended` from `end`, `scheduled` before `start` or between periods, `active`
 * inside `[start, end)` and a period and outside every exception. An effect
 * whose issues say its window could not be read is `unknown`: it neither
 * routes nor displays as active. `nextTransitionAt` is the next instant the
 * state changes, when one is known.
 */
export function effectStateAt(
  effect: Pick<Effect, "validity" | "issues">,
  situation: Validity,
  at: Date,
): { state: EffectState; nextTransitionAt: string | null } {
  const t = at.getTime();
  if (!Number.isFinite(t) || (effect.issues ?? []).some((i) => TEMPORAL_ISSUES.has(i.code))) {
    return { state: "unknown", nextTransitionAt: null };
  }
  const v = effectValidity(effect, situation);
  const start = v.start === undefined ? null : Date.parse(v.start);
  const end = v.end === undefined ? null : Date.parse(v.end);
  if (end !== null && t >= end) return { state: "ended", nextTransitionAt: null };
  if (start !== null && t < start) return { state: "scheduled", nextTransitionAt: v.start! };
  const next = earliest([
    v.end,
    nextScheduleTransition(v.periods ?? [], at),
    nextScheduleTransition(v.exceptions ?? [], at),
  ]);
  return { state: isValidityInEffectAt(v, at) ? "active" : "scheduled", nextTransitionAt: next };
}

/** Why an effect may not constrain shared routing. */
export type RoutingBlocker = "applicability_unknown" | "not_normalized" | "action_not_routable";

/**
 * Operator action statuses under which the action is not in place, by DATEX
 * `OperatorActionStatusEnum`: a request neither approved nor acted on, an
 * approved action whose implementation "has not yet commenced", and a rejected
 * one, "hence not implemented". An action whose termination is requested ("has
 * not yet commenced") or under way is still in place.
 */
const NON_ROUTING_ACTIONS = new Set(["requested", "approved", "rejected"]);

/** Whether the operator action an effect states, if any, is in place. */
export function actionInPlace(effect: Pick<Effect, "actionStatus">): boolean {
  return effect.actionStatus === undefined || !NON_ROUTING_ACTIONS.has(effect.actionStatus);
}

/**
 * Whether a declared lifecycle leaves an effect's window to decide when it is
 * in force: only `active` does. A planned or suspended record is not in force
 * whatever its window says, an ended or cancelled one no longer is, and an
 * unknown status establishes nothing, so none of them may route.
 */
export function lifecycleInForce(validity: Pick<Validity, "status">): boolean {
  return validity.status === "active";
}

/**
 * The routing contract every effect is held to, independent of time, binding
 * and rights (those are checked at the edge). An effect whose vehicles are
 * unknown or that the parser could not fully type is restriction evidence:
 * stored, listed and counted, never routed. An operator action that is not in
 * place (requested, approved, rejected) never routes either.
 */
export function routingBlockers(
  effect: Pick<Effect, "applicability" | "normalization" | "actionStatus">,
): RoutingBlocker[] {
  const blockers: RoutingBlocker[] = [];
  if (effect.applicability.kind === "unknown") blockers.push("applicability_unknown");
  if (effect.normalization !== "complete") blockers.push("not_normalized");
  if (!actionInPlace(effect)) blockers.push("action_not_routable");
  return blockers;
}

/** A situation's own effects and the effects of its phases. */
export function situationEffects(situation: Record<string, unknown>): Effect[] {
  const details = situation["details"] as { phases?: { effects?: Effect[] }[] } | undefined;
  return [
    ...((situation["effects"] as Effect[] | undefined) ?? []),
    ...(details?.phases ?? []).flatMap((phase) => phase.effects ?? []),
  ];
}

/** Effect kinds that are vehicle-specific whatever vehicles they name. */
const VEHICLE_KINDS = new Set(["dimension_limit", "hazmat", "unsupported"]);

/**
 * An effect that applies to some vehicles only, or is a vehicle rule in
 * itself: what a format without vehicle conditions cannot carry truthfully.
 */
export function isVehicleSpecific(effect: Pick<Effect, "kind" | "applicability">): boolean {
  return VEHICLE_KINDS.has(effect.kind) || effect.applicability.kind !== "all";
}

/** Restriction evidence: present, but withheld from shared routing and lossy exports. */
export function isRestrictionEvidence(
  effect: Pick<Effect, "applicability" | "normalization">,
): boolean {
  return effect.applicability.kind === "unknown" || effect.normalization !== "complete";
}
