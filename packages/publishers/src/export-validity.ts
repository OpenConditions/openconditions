import {
  actionInPlace,
  type Effect,
  effectStateAt,
  effectValidity,
  type Issue,
  type Validity,
} from "@openconditions/model";

type Rec = Record<string, unknown>;
export interface ProjectionEffect {
  effect: Effect;
  validity: Validity;
  validityPath: string;
}

/** Preserve the phase fallback contract while retaining original effect identity. */
export function projectionEffects(situation: Rec): ProjectionEffect[] {
  const root = situation["validity"] as Validity;
  const contexts = (effects: Effect[], parent: Validity, path: string, parentPath: string) =>
    effects.map((effect, i) => ({
      effect,
      validity: effectValidity(effect, parent),
      validityPath: effect.validity ? `${path}/${i}/validity` : parentPath,
    }));
  const out = contexts(
    (situation["effects"] as Effect[] | undefined) ?? [],
    root,
    "/effects",
    "/validity",
  );
  const details = situation["details"] as
    | { phases?: { validity?: Validity; effects?: Effect[] }[] }
    | undefined;
  for (const [i, phase] of (details?.phases ?? []).entries()) {
    const path = `/details/phases/${i}`;
    out.push(
      ...contexts(
        phase.effects ?? [],
        phase.validity ?? root,
        `${path}/effects`,
        phase.validity ? `${path}/validity` : "/validity",
      ),
    );
  }
  return out;
}

/** Metadata/status do not change an interval; timestamp offsets do not either. */
export function sameInterval(a: Validity, b: Validity): boolean {
  const instant = (value: string | undefined) =>
    value === undefined ? undefined : Date.parse(value);
  return instant(a.start) === instant(b.start) && instant(a.end) === instant(b.end);
}

/** Whether an issue only restates the declared lifecycle its validity already carries. */
function restatesLifecycle(issue: Issue, validity: Validity): boolean {
  return (
    issue.code === "unsupported_status" &&
    issue.sourceTokens?.["validityStatus"] === validity.status
  );
}

export interface ProjectionState {
  state: "active" | "scheduled" | "ended" | "unknown";
  /** For an unknown state, what left it unknown: the lifecycle, the action status or an issue. */
  cause?: "status" | "actionStatus" | "issues";
}

/**
 * The state an effect is exported in at `at`. An ended or cancelled lifecycle
 * has ended it and an unknown one establishes nothing. A format that carries
 * the lifecycle and the operator action's status (`carriesStatus`, DATEX)
 * exports a planned or suspended effect by its window, stating the status;
 * one that cannot never exports such an effect, or an action that is not in
 * place, as in force: the same effect would read as active.
 */
export function projectionStateAt(
  { effect, validity }: ProjectionEffect,
  at: Date,
  carriesStatus = false,
): ProjectionState {
  if (validity.status === "ended" || validity.status === "cancelled") return { state: "ended" };
  if (validity.status === "unknown") return { state: "unknown", cause: "status" };
  const declared = validity.status === "planned" || validity.status === "suspended";
  if (carriesStatus && declared) {
    const issues = (effect.issues ?? []).filter((i) => !restatesLifecycle(i, validity));
    const { state } = effectStateAt({ ...effect, issues }, validity, at);
    return state === "unknown" ? { state, cause: "issues" } : { state };
  }
  const { state } = effectStateAt(effect, validity, at);
  if (state === "unknown") {
    return {
      state,
      cause:
        declared && effect.issues?.some((i) => restatesLifecycle(i, validity))
          ? "status"
          : "issues",
    };
  }
  if (state === "active" && !carriesStatus) {
    if (declared) return { state: "unknown", cause: "status" };
    if (!actionInPlace(effect)) return { state: "unknown", cause: "actionStatus" };
  }
  return { state };
}

/** The JSON pointer an omitted effect's diagnostic names. */
export function omittedPath(
  context: ProjectionEffect,
  { state, cause }: ProjectionState,
  effectPath: string,
): string {
  if (state !== "unknown") return context.validityPath;
  if (cause === "status") return `${context.validityPath}/status`;
  if (cause === "actionStatus") return `${effectPath}/actionStatus`;
  return `${effectPath}/issues`;
}

/** Generic management classifications describe their concrete management effects,
 * even when scope/subtype produces a different wire discriminator.
 */
export function definesManagementNature(situation: Rec, effect: Effect): boolean {
  return (
    (situation["kind"] === "closure" &&
      ["closure", "lane_restriction", "contraflow"].includes(effect.kind)) ||
    (situation["kind"] === "pass_status" &&
      situation["type"] === "pass" &&
      situation["subtype"] === "closed" &&
      effect.kind === "closure") ||
    (situation["kind"] === "restriction" &&
      situation["type"] === "speed" &&
      effect.kind === "speed_limit")
  );
}
