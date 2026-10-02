/**
 * The reviewer accept/reject decisions — the accountable, post-hoc resolution
 * of a flagged situation. On a crowd report both call
 * {@link applyExternalResolution} (the ONE place reporter reputation is
 * trained); neither re-implements the resolution or reputation math.
 *
 * accept → a crowd report is externally CONFIRMED: it becomes
 * `externally_resolved` and routing-eligible, its pre-settlement confirmers
 * are trained `confirmed`, and its open flag is cleared. On a feed record a
 * reviewer has nothing to resolve (its source decides its truth), so accept
 * only clears the flag.
 *
 * reject → a crowd report is externally REJECTED and TOMBSTONED `rejected` in
 * ONE transaction under the crowd lock: the resolution negates it and trains
 * `rejected`, then the write seam tombstones it, so it leaves every read and
 * federates as a delete. The `report_evidence` ledger is RETAINED for audit.
 * A feed record cannot be rejected here: its source would publish it again.
 */

import type { EvidenceState, Registry } from "@openconditions/model";
import { tombstoneRecords } from "@openconditions/storage";
import type postgres from "postgres";
import { lockCrowd } from "../crowd.js";
import { applyExternalResolution } from "../reputation/resolve.js";

type Sql = postgres.Sql;

export type DecisionOutcome =
  | { code: 404; error: string }
  | { code: 409; error: string }
  | {
      code: 200;
      record: { class: "situation"; id: string };
      evidenceState: EvidenceState | null;
      routingEligible: boolean;
      tombstoned?: boolean;
    };

interface GateRow {
  origin: string;
  tombstoned: boolean;
  evidence_state: EvidenceState | null;
  routing_eligible: boolean;
}

async function loadLocked(tx: postgres.TransactionSql, id: string): Promise<GateRow | null> {
  const [row] = await tx<GateRow[]>`
    SELECT origin, tombstoned_at IS NOT NULL AS tombstoned, evidence_state, routing_eligible
    FROM conditions.situation WHERE id = ${id} FOR UPDATE
  `;
  return row ?? null;
}

export async function acceptSituation(
  sql: Sql,
  registry: Registry,
  id: string,
  now: string,
): Promise<DecisionOutcome> {
  return sql.begin(async (tx) => {
    await lockCrowd(tx);
    const row = await loadLocked(tx, id);
    if (row === null) return { code: 404, error: "situation not found" };
    if (
      row.tombstoned ||
      row.evidence_state === "externally_resolved" ||
      row.evidence_state === "negated"
    ) {
      return { code: 409, error: "situation already resolved or ended" };
    }
    let state: { evidenceState: EvidenceState | null; routingEligible: boolean } = {
      evidenceState: row.evidence_state,
      routingEligible: row.routing_eligible,
    };
    if (row.origin === "crowd") {
      const resolution = await applyExternalResolution(
        sql,
        registry,
        id,
        { source: "reviewer", outcome: "confirmed" },
        now,
        tx,
      );
      if (resolution !== null) state = resolution;
    }
    await tx`UPDATE conditions.situation SET flagged_at = NULL WHERE id = ${id}`;
    return { code: 200, record: { class: "situation", id }, ...state };
  });
}

export async function rejectSituation(
  sql: Sql,
  registry: Registry,
  id: string,
  now: string,
): Promise<DecisionOutcome> {
  return sql.begin(async (tx) => {
    await lockCrowd(tx);
    const row = await loadLocked(tx, id);
    if (row === null) return { code: 404, error: "situation not found" };
    if (row.tombstoned) return { code: 409, error: "situation already ended" };
    if (row.origin !== "crowd") {
      return {
        code: 409,
        error: "only a crowd report can be rejected; its source decides a feed record",
      };
    }
    const resolution = await applyExternalResolution(
      sql,
      registry,
      id,
      { source: "reviewer", outcome: "rejected" },
      now,
      tx,
    );
    await tx`UPDATE conditions.situation SET flagged_at = NULL WHERE id = ${id}`;
    await tombstoneRecords(tx, "situation", [id], "rejected", { registry, now });
    return {
      code: 200,
      record: { class: "situation", id },
      evidenceState: resolution?.evidenceState ?? row.evidence_state,
      routingEligible: resolution?.routingEligible ?? false,
      tombstoned: true,
    };
  });
}
