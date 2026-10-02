/**
 * The StreetComplete landing rule: after a new report lands, if it agrees
 * with a live situation that carries an OPEN flag (`situationsAgree`: the same
 * kind and type, in effect then, within the kind's match distance), flag the
 * NEW report too. A cheap "don't let reports pile onto a disputed element
 * unnoticed" signal — warn-level and post-hoc: the report has already landed
 * 200; this NEVER blocks it, and nothing merges.
 */

import { crowdRulesFor, type Registry, situationsAgree } from "@openconditions/model";
import type postgres from "postgres";
import { agreeing, loadSituation, nearbySituations } from "../crowd.js";

type Sql = postgres.Sql;

/** True when the report was flagged because it agrees with an open-flagged situation. */
export async function flagOntoOpenFlagged(
  sql: Sql,
  registry: Registry,
  situationId: string,
  now: string,
): Promise<boolean> {
  const target = await loadSituation(sql, situationId);
  if (target === undefined || target.tombstoneReason !== null) return false;
  const rules = crowdRulesFor(registry, {
    class: "situation",
    kind: target.kind,
    type: target.type,
  });
  if (rules === undefined) return false;
  const nearby = await nearbySituations(sql, target, rules.matchMetres!, {
    origins: ["feed", "crowd", "federation", "derived"],
  });
  const disputed = nearby.some(
    (s) => s.flaggedAt !== null && situationsAgree(registry, agreeing(target), agreeing(s)),
  );
  if (!disputed) return false;
  await sql`
    UPDATE conditions.situation SET flagged_at = ${now}
    WHERE id = ${situationId} AND flagged_at IS NULL
  `;
  return true;
}
