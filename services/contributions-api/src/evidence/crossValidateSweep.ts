/**
 * Feed-arrives-later cross-validation. The landing hook only sees the feeds
 * that exist when a crowd report lands; a feed that publishes the same event
 * minutes later would never validate it. The sweep re-runs
 * {@link crossValidateAgainstFeeds} for every live, not yet routing-eligible
 * crowd report on a schedule, bounded per cycle so a burst of reports cannot
 * starve the service.
 */

import type { Registry } from "@openconditions/model";
import type postgres from "postgres";
import { crossValidateAgainstFeeds as defaultCrossValidate } from "./crossValidate.js";
import { crossValidateObservation as defaultCrossValidateObservation } from "./crossValidateObservation.js";

type Sql = postgres.Sql;

/** At most this many candidates per cycle; the rest wait for the next one. */
export const DEFAULT_SWEEP_MAX_BATCH = 500;

export interface SweepCrossValidateDeps {
  crossValidateAgainstFeeds?: typeof defaultCrossValidate;
  maxBatch?: number;
  log?: (message: string) => void;
}

export interface SweepResult {
  scanned: number;
  routed: number;
}

type Candidates = "local" | "federated";

/**
 * Local reports carry the reporter's key; a peer's crowd report is keyless
 * and arrived with at least one origin-chain hop. Local candidates go oldest
 * report first; federated ones soonest-expiring first, so a burst of
 * long-lived peer reports cannot starve the ones about to lapse.
 */
function candidateFilter(sql: Sql, which: Candidates, now: string) {
  const keyed =
    which === "local"
      ? sql`record #>> '{provenance,reporter,keyId}' IS NOT NULL`
      : sql`record #>> '{provenance,reporter,keyId}' IS NULL
            AND jsonb_array_length(COALESCE(record #> '{provenance,originChain}', '[]')) > 0`;
  return sql`
    origin = 'crowd'
    AND tombstoned_at IS NULL
    AND routing_eligible = false
    AND ${keyed}
    AND expires_at > ${now}`;
}

async function sweep(
  sql: Sql,
  registry: Registry,
  now: string,
  which: Candidates,
  deps: SweepCrossValidateDeps,
): Promise<SweepResult> {
  const crossValidate = deps.crossValidateAgainstFeeds ?? defaultCrossValidate;
  const maxBatch = deps.maxBatch ?? DEFAULT_SWEEP_MAX_BATCH;
  const log = deps.log ?? (() => {});
  const label = which === "local" ? "cross-validate-sweep" : "federated-cross-validate-sweep";
  const order = which === "local" ? sql`valid_from ASC, id` : sql`expires_at ASC, id`;

  const rows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.situation
    WHERE ${candidateFilter(sql, which, now)}
    ORDER BY ${order}
    LIMIT ${maxBatch + 1}
  `;
  const overflow = rows.length > maxBatch;
  const batch = overflow ? rows.slice(0, maxBatch) : rows;
  if (overflow) {
    const [{ n: total } = { n: batch.length }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.situation
      WHERE ${candidateFilter(sql, which, now)}
    `;
    log(
      `[${label}] candidate batch capped at ${maxBatch}; ` +
        `deferring ${total - maxBatch} candidate(s) to a later cycle`,
    );
  }

  let scanned = 0;
  let routed = 0;
  for (const { id } of batch) {
    scanned += 1;
    try {
      const matched = await crossValidate(
        sql,
        registry,
        id,
        now,
        which === "federated" ? { allowFederatedTarget: true } : {},
      );
      if (matched !== null) routed += 1;
    } catch (err) {
      log(`[${label}] candidate ${id} failed: ${String(err)}`);
    }
  }
  return { scanned, routed };
}

/** Cross-validate this instance's own live crowd reports against its feeds. */
export function sweepCrossValidate(
  sql: Sql,
  registry: Registry,
  now: string,
  deps: SweepCrossValidateDeps = {},
): Promise<SweepResult> {
  return sweep(sql, registry, now, "local", deps);
}

/** Cross-validate the live crowd reports peers federated against this instance's feeds. */
export function sweepFederatedCrossValidate(
  sql: Sql,
  registry: Registry,
  now: string,
  deps: SweepCrossValidateDeps = {},
): Promise<SweepResult> {
  return sweep(sql, registry, now, "federated", deps);
}

export interface SweepObservationDeps {
  crossValidateObservation?: typeof defaultCrossValidateObservation;
  maxBatch?: number;
  log?: (message: string) => void;
}

/**
 * Cross-validate this instance's live, unsettled crowd readings against its
 * feed readings: a feed that publishes the same reading after the report,
 * while it is alive, resolves it then. Soonest-expiring first, bounded per
 * cycle as the situation sweep is.
 */
export async function sweepCrossValidateObservations(
  sql: Sql,
  registry: Registry,
  now: string,
  deps: SweepObservationDeps = {},
): Promise<SweepResult> {
  const crossValidate = deps.crossValidateObservation ?? defaultCrossValidateObservation;
  const maxBatch = deps.maxBatch ?? DEFAULT_SWEEP_MAX_BATCH;
  const log = deps.log ?? (() => {});
  const rows = await sql<{ id: string }[]>`
    SELECT crowd_record_id AS id FROM conditions.observation_latest
     WHERE source_id = 'crowd' AND expires_at > ${now}
       AND evidence_state IN ('self_reported', 'corroborated')
       AND reading #>> '{provenance,reporter,keyId}' IS NOT NULL
     ORDER BY expires_at, series_id
     LIMIT ${maxBatch}`;
  let routed = 0;
  for (const { id } of rows) {
    try {
      if ((await crossValidate(sql, registry, id, now)) !== null) routed += 1;
    } catch (err) {
      log(`[observation-cross-validate-sweep] candidate ${id} failed: ${String(err)}`);
    }
  }
  return { scanned: rows.length, routed };
}

/** The sweep runs unless `OPENCONDITIONS_CROSS_VALIDATE_SWEEP=off`. */
export function isCrossValidateSweepEnabled(env: Record<string, string | undefined>): boolean {
  return env["OPENCONDITIONS_CROSS_VALIDATE_SWEEP"] !== "off";
}

/** Wrap a job so a cycle that is still running makes the next tick a no-op. */
export function singleFlight(run: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } finally {
      running = false;
    }
  };
}
