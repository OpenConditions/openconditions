import { type Effect, effectStateAt, effectValidity, type Validity } from "@openconditions/model";

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

/** Source lifecycle cannot be serialized as an active XML restriction. */
export function projectionStateAt({ effect, validity }: ProjectionEffect, at: Date) {
  if (validity.status === "ended" || validity.status === "cancelled")
    return { state: "ended" as const };
  if (validity.status === "unknown") return { state: "unknown" as const };
  return effectStateAt(effect, validity, at);
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
