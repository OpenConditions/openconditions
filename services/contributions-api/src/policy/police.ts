/**
 * Per-instance police-category gate — DEFAULT OFF.
 *
 * The sensitive police-presence category is off by default and a report in it
 * only lands when an operator has explicitly opted the instance in via
 * `OPENCONDITIONS_ALLOW_POLICE_CATEGORY=true`. This is a defense-in-depth
 * backstop: the client dialog already omits the category, so a well-behaved
 * client never sends it; a hand-crafted request that does is refused here
 * before any DB write.
 *
 * The gated set is EXACTLY {"police"} — the explicit client-facing
 * police-presence category kept off by default (see the policy rationale in
 * docs/crowd-reporting-limitations.md). It is deliberately narrow:
 *
 *   - "authority" is NOT gated. It is the legitimate official/road-authority
 *     activity category (the canonical schema maps GTFS-RT POLICE_ACTIVITY →
 *     authority); road-authority presence is ordinary operational data.
 *   - "security" is NOT gated. It covers legitimate security-incident reports.
 *   - "speed_restriction" is NOT gated.
 *
 * Matching is case-insensitive and trimmed so "Police" / " police " cannot
 * slip past the gate.
 */

/** The exact set of canonical types gated by the police toggle. */
export const POLICE_TYPES: ReadonlySet<string> = new Set(["police"]);

/** True when a report's canonical type falls in the gated police-presence set. */
export function isPoliceCategory(type: string): boolean {
  return POLICE_TYPES.has(type.trim().toLowerCase());
}

/** True when the instance has explicitly enabled the police category. */
export function isPoliceCategoryEnabled(env: Record<string, string | undefined>): boolean {
  return env["OPENCONDITIONS_ALLOW_POLICE_CATEGORY"] === "true";
}
