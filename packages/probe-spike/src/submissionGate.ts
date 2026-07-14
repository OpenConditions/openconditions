/**
 * The admission→aggregation binding: one admitted Privacy Pass token buys the
 * right to land AT MOST ONE report in AT MOST ONE batch.
 *
 * Order of operations (fail closed):
 *  1. Redeem the token. Redemption is single-use and context-bound — the shipped
 *     `@openconditions/contributions-api/contrib` TokenVerifier owns that
 *     (spent_token INSERT-first, domain-separated redemptionContext). A replayed
 *     token, or a token minted for another purpose/task/epoch, redeems false.
 *  2. Admit the report id / VDAF nonce into the batch. A report id already in the
 *     batch is a replay and is refused — the same report cannot enter two
 *     batches, and a fresh token cannot re-land an already-batched report id.
 *
 * The gate never persists the raw `(segment, window, speed)` tuple — only the
 * encrypted VDAF shares the protocol carries and the report-id dedup marker.
 *
 * `redeemToken` is injected rather than imported so this spike's source keeps a
 * one-way dependency edge (nothing here reaches back into a production service at
 * runtime); the tests wire in the real TokenVerifier.
 */
import type postgres from "postgres";

/**
 * Per-key-per-epoch admission ceiling for the probe purpose. This MUST be 1:
 * invariant 2 ("one admitted key/epoch → at most one accepted contribution")
 * holds only when probe issuance is capped at one token per epoch. The shipped
 * attester default (`ATTESTER_POLICY.grantTokensPerEpoch = 20`) does NOT enforce
 * this on its own — the production probe issuance path MUST pass this cap to
 * `issueToken` (or a probe-specific policy that pins it to 1).
 */
export const PROBE_TOKENS_PER_EPOCH = 1;

/** Structurally compatible with contributions-api's PublicContext. */
export interface ContributionContext {
  purpose: string;
  taskId?: string;
  epoch: string;
}

/** Injected single-use, context-bound token redemption (the Plan-1 verifier). */
export type TokenRedeemer = (
  tokenBytes: Uint8Array,
  context: ContributionContext,
  nowIso: string
) => Promise<boolean>;

export interface ProbeSubmission {
  tokenBytes: Uint8Array;
  context: ContributionContext;
  /** 16-byte report id / VDAF nonce that anchors batch anti-replay. */
  reportId: Uint8Array;
  nowIso: string;
}

export type AcceptanceRefusal = "token-refused" | "report-replayed";

export type ProbeAcceptance =
  | { accepted: true; batch: string; reportId: string }
  | { accepted: false; reason: AcceptanceRefusal };

const SCHEMA = "probe_spike";

/** Creates the spike-only batch-membership table (never a production migration). */
export async function ensureBatchSchema(sql: postgres.Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql(SCHEMA)}`;
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql(SCHEMA)}.batch_report (
      batch text NOT NULL,
      report_id text NOT NULL,
      admitted_at timestamptz NOT NULL,
      PRIMARY KEY (batch, report_id)
    )
  `;
}

/** The batch a report lands in: its context is the batch identity. */
export function batchKey(context: ContributionContext): string {
  return `${context.purpose}:${context.taskId ?? "-"}:${context.epoch}`;
}

// The (batch, report_id) dedup is PER-BATCH scoped: the same report id in a
// DIFFERENT batch is not blocked by this primary key. That is intentional —
// landing the same report id in another batch requires a fresh admission token,
// and admission is capped at one per key/epoch (PROBE_TOKENS_PER_EPOCH). So
// "cannot enter two batches" is ultimately enforced at the ADMISSION layer, not
// by this dedup PK; the PK only stops a double-land WITHIN one batch.

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Admits a report id into its batch exactly once. Returns false when the report
 * id is already present (a replay) — INSERT ... ON CONFLICT DO NOTHING makes the
 * check atomic under concurrency.
 */
async function admitReport(
  sql: postgres.Sql,
  batch: string,
  reportId: string,
  nowIso: string
): Promise<boolean> {
  const rows = await sql<{ report_id: string }[]>`
    INSERT INTO ${sql(SCHEMA)}.batch_report (batch, report_id, admitted_at)
    VALUES (${batch}, ${reportId}, ${new Date(nowIso)})
    ON CONFLICT (batch, report_id) DO NOTHING
    RETURNING report_id
  `;
  return rows.length > 0;
}

/**
 * Redeems the admission token, then admits the report id into its batch. Both
 * must succeed for the report to be accepted; either failure is a fail-closed
 * refusal. A token consumed for a report that is then refused as a replay stays
 * spent — a burned token is harmless.
 */
export async function acceptProbeReport(
  sql: postgres.Sql,
  redeemToken: TokenRedeemer,
  submission: ProbeSubmission
): Promise<ProbeAcceptance> {
  const redeemed = await redeemToken(submission.tokenBytes, submission.context, submission.nowIso);
  if (!redeemed) {
    return { accepted: false, reason: "token-refused" };
  }

  const batch = batchKey(submission.context);
  const reportId = toHex(submission.reportId);
  const admitted = await admitReport(sql, batch, reportId, submission.nowIso);
  if (!admitted) {
    return { accepted: false, reason: "report-replayed" };
  }
  return { accepted: true, batch, reportId };
}
