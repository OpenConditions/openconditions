/**
 * Landing-time auto-corroboration: the second step of the evidence ladder.
 * After a fresh crowd report lands, if an INDEPENDENT crowd report of the same
 * phenomenon is already nearby — the same kind and type, in effect when this
 * one was reported, within the kind's match distance (`situationsAgree`) —
 * the two are merged. The survivor is NOT "the just-landed report":
 * `applyCorroboration` chooses it by a stable global order (earlier survives)
 * under the row lock, so two concurrent landings converge on one survivor
 * instead of annihilating each other. Two independent witnesses raise the
 * survivor to `corroborated`.
 *
 * Nearby superseded reports are redirected to their live survivor, so a 3rd
 * witness that only neighbours an already-merged report re-credits the real
 * phenomenon instead of landing unlinked. Corroboration NEVER makes a report
 * routing-eligible and NEVER trains reputation — only an external resolution
 * does.
 */

import { crowdRulesFor, type Registry, situationsAgree } from "@openconditions/model";
import type postgres from "postgres";
import { actorOf, agreeing, loadSituation, loadSituations, nearbySituations } from "../crowd.js";
import { applyCorroboration, resolveSurvivors } from "./corroborate.js";

type Sql = postgres.Sql;

/**
 * Auto-corroborate the just-landed crowd situation `situationId` against
 * every INDEPENDENT crowd report of the same phenomenon. Returns the ids it
 * corroborated with (empty when the situation is not a live keyed crowd
 * report, is flagged, or nothing agrees).
 */
export async function autoCorroborateOnLanding(
  sql: Sql,
  registry: Registry,
  situationId: string,
  now: string,
): Promise<string[]> {
  const target = await loadSituation(sql, situationId);
  if (target === undefined || target.tombstoneReason !== null) return [];
  const actor = actorOf(target.record);
  // A peer's crowd report carries no key: it is no independent witness, and
  // merging it either way would supersede a report with one this instance
  // does not federate.
  if (actor.origin !== "crowd" || actor.keyId === undefined) return [];
  // A disputed (flagged) landing is not a clean witness: a kinematically
  // implausible report, or one that piled onto an already-disputed element (the
  // StreetComplete rule), must stay a distinct report for review rather than be
  // silently merged into another. Corroboration waits for the dispute to clear.
  if (target.flaggedAt !== null) return [];
  const rules = crowdRulesFor(registry, {
    class: "situation",
    kind: target.kind,
    type: target.type,
  });
  if (rules === undefined) return [];

  const nearby = await nearbySituations(sql, target, rules.matchMetres!, {
    origins: ["crowd"],
    includeSuperseded: true,
  });
  const resolved = await resolveSurvivors(
    sql,
    nearby.map((s) => s.id),
  );
  const survivorIds = new Set<string>();
  for (const survivorId of resolved.values()) {
    if (survivorId !== null && survivorId !== situationId) survivorIds.add(survivorId);
  }
  if (survivorIds.size === 0) return [];

  // Match against the SURVIVORS (re-read by id — a survivor may sit outside
  // the just-landed report's match distance). Only keyed reports from another
  // reporter are independent witnesses: a peer's crowd report carries no key,
  // and a key never corroborates itself. Never corroborate ONTO a disputed
  // (flagged) survivor either — that waits for a reviewer.
  const survivors = await loadSituations(sql, [...survivorIds]);
  const corroborated: string[] = [];
  for (const survivor of survivors) {
    const witness = actorOf(survivor.record);
    if (witness.keyId === undefined || witness.keyId === actor.keyId) continue;
    if (survivor.flaggedAt !== null || survivor.tombstoneReason !== null) continue;
    // Two crowd reports agree whichever was made first: an earlier report
    // that lands later (an offline upload) still meets the later one.
    const [a, b] = [agreeing(target), agreeing(survivor)];
    if (!situationsAgree(registry, a, b) && !situationsAgree(registry, b, a)) continue;
    await applyCorroboration(sql, registry, situationId, survivor.id, now);
    corroborated.push(survivor.id);
  }
  return corroborated;
}
