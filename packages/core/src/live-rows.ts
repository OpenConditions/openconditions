// What the readers of current rows share, kept out of the package barrel:
// the latest-reading clauses and record columns of `listLatestObservations`
// and `latestOfFeatures`, and the live-offer clauses of `listOffers` and
// `offersOfFeatures`.
import { FUSED_PUBLIC_SOURCE_ID, FUSED_SOURCE_ID } from "@openconditions/model";
import { type Scope, scopeClauses } from "./record-filters.js";

/** The source id of every crowd row, local or a peer's. */
export const CROWD_SOURCE_ID = "crowd";

/**
 * The WHERE clauses `scope` adds over the latest-reading table aliased `t`,
 * which choose the fused reading a scope reads (at most one per subject,
 * property and qualifiers). The operator reads the `@fused` row, the fusion
 * of every contributor. The public reads the fused row flagged
 * `fused_public`: an `@fused` row all of whose contributors are public, or
 * else the `@fused-public` row beside it. Besides a restricted source's own
 * readings, it also withholds a fused reading any restricted source
 * contributed to (`fused_sources`), which covers a source restricted since
 * the row was fused.
 */
function latestScopeClauses(t: string, scope: Scope): string[] {
  if (scope === "operator") return [`${t}.source_id <> '${FUSED_PUBLIC_SOURCE_ID}'`];
  return [
    ...scopeClauses(t, scope),
    `(${t}.source_id NOT IN ('${FUSED_SOURCE_ID}', '${FUSED_PUBLIC_SOURCE_ID}') OR ${t}.fused_public)`,
    `NOT EXISTS (SELECT 1 FROM unnest(${t}.fused_sources) contributor(id)
       JOIN conditions.source scope_source ON scope_source.id = contributor.id
      WHERE scope_source.restricted)`,
  ];
}

/**
 * The WHERE clauses of the readings over the latest-reading table aliased
 * `t` that are current at `at` (a placeholder of a timestamptz) and that
 * `scope` may see: not past their expiry, a crowd reading's evidence neither
 * expired nor negated, and of the fused rows only the one the scope reads.
 */
export function currentReadingClauses(t: string, at: string, scope: Scope): string[] {
  return [
    `(${t}.expires_at IS NULL OR ${t}.expires_at > ${at}::timestamptz)`,
    `(${t}.evidence_state IS NULL OR ${t}.evidence_state NOT IN ('expired', 'negated'))`,
    ...latestScopeClauses(t, scope),
  ];
}

/**
 * The select list of a latest-reading row of the table aliased `t` as its
 * stored record (`record`) with the evidence summary `withEvidence` merges.
 */
export function readingColumns(t: string): string {
  return `conditions.observation_record(${t}.template, ${t}.reading) AS record,
            ${t}.evidence_state, ${t}.confidence_score,
            false AS routing_eligible, ${t}.corroborations`;
}

/**
 * The WHERE clauses of the offers of the table aliased `t` live at `at` (a
 * placeholder of a timestamptz): not tombstoned, not past their expiry,
 * their validity not ended.
 */
export function liveOfferClauses(t: string, at: string): string[] {
  return [
    `${t}.tombstoned_at IS NULL`,
    `(${t}.expires_at IS NULL OR ${t}.expires_at > ${at}::timestamptz)`,
    `(${t}.valid_to IS NULL OR ${t}.valid_to > ${at}::timestamptz)`,
  ];
}
