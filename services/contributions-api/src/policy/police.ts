/**
 * Per-instance police-presence gate — DEFAULT OFF.
 *
 * A crowd report of police presence only lands when an operator has
 * explicitly opted the instance in via `OPENCONDITIONS_ALLOW_POLICE_CATEGORY=true`
 * (see the policy rationale in docs/crowd-reporting-limitations.md). Police
 * presence is the `authority.operation` situation with a `police_*` subtype
 * (`police_checkpoint`, `police_activity`). The production registry gives the
 * `authority` kind no crowd rules, so such a claim already fails validation;
 * the gate is defense in depth for a registry that lets the crowd report the
 * kind. Other authority subtypes (customs, enforcement, weighing, …) are
 * ordinary operational data and are not gated.
 */

/** The kind, type and subtype prefix of police presence. */
const POLICE = { kind: "authority", type: "operation", subtypePrefix: "police_" } as const;

/** True when a situation claim reports police presence. */
export function isPoliceClaim(claim: { kind?: string; type?: string; subtype?: string }): boolean {
  return (
    claim.kind === POLICE.kind &&
    claim.type === POLICE.type &&
    typeof claim.subtype === "string" &&
    claim.subtype.startsWith(POLICE.subtypePrefix)
  );
}

/** True when the instance has explicitly enabled police-presence reports. */
export function isPoliceCategoryEnabled(env: Record<string, string | undefined>): boolean {
  return env["OPENCONDITIONS_ALLOW_POLICE_CATEGORY"] === "true";
}
