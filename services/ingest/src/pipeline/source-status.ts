import type postgres from "postgres";
import { redactSecrets, redactUrl } from "@openconditions/ingest-framework";

type Sql = postgres.Sql | postgres.TransactionSql;

export type SourcePollOutcome =
  | "changed"
  | "validated_unchanged"
  | "complete_empty"
  | "partial"
  | "failed"
  | "skipped_cadence"
  | "skipped_overlap"
  | "missing_configuration";

export interface PublicationFacts {
  activeEvents: number;
  /** Legacy retained-row stock (events + measurements); keeps last_row_count semantics. */
  rowCount?: number;
  inserted: number;
  updated: number;
  deleted: number;
  rejected: number;
}

export interface SourceStatusUpdate {
  freshnessWindowSec: number;
  outcome: SourcePollOutcome | "success" | "error";
  attemptAt?: string;
  networkValidated?: boolean;
  publication?: PublicationFacts;
  durationMs?: number;
  error?: string;
  partitions?: { succeeded: number; failed: number; total: number };
  /** Compatibility input used by callers predating explicit publication facts. */
  rowCount?: number;
}

export interface SourceOperationalStatus {
  source: string;
  lastAttemptAt?: string;
  lastNetworkSuccessAt?: string;
  freshnessDeadline?: string;
  lastPublicationAt?: string;
  publicationRevision: number;
  lastOutcome?: SourcePollOutcome;
  activeEvents?: number;
  lastInserted?: number;
  lastUpdated?: number;
  lastDeleted?: number;
  lastRejected?: number;
  lastDurationMs?: number;
  consecutiveFailures: number;
  lastError?: string;
  lastErrorAt?: string;
}

export type SourceStatusReader = () => Promise<Map<string, SourceOperationalStatus>>;

function normalizedOutcome(update: SourceStatusUpdate): SourcePollOutcome {
  if (update.outcome === "success") return update.publication ? "changed" : "validated_unchanged";
  if (update.outcome === "error") return "failed";
  return update.outcome;
}

function sanitizeError(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const values: string[] = [];
  for (const match of raw.matchAll(/https?:\/\/\S+/g)) {
    try {
      for (const value of new URL(match[0]).searchParams.values()) if (value) values.push(value);
    } catch {
      // redactUrl below also handles malformed URL-looking strings.
    }
  }
  return redactSecrets(
    raw.replace(/https?:\/\/\S+/g, (url) => redactUrl(url)),
    values
  ).slice(0, 1_000);
}

const iso = (value: Date | string | null): string | undefined =>
  value == null ? undefined : new Date(value).toISOString();

/** Persist one poll fact and update the source's durable current state. Network
 * validation and publication advance independently; a local skip renews neither. */
export async function upsertSourceStatus(
  sql: Sql,
  sourceId: string,
  update: SourceStatusUpdate
): Promise<void> {
  const attemptedAt = update.attemptAt ?? new Date().toISOString();
  const outcome = normalizedOutcome(update);
  const networkValidated =
    update.networkValidated ?? (update.outcome === "success" || outcome === "validated_unchanged");
  const publication =
    update.publication ??
    (update.rowCount != null
      ? { activeEvents: update.rowCount, inserted: 0, updated: 0, deleted: 0, rejected: 0 }
      : undefined);
  const error = sanitizeError(update.error);
  const durationMs = update.durationMs == null ? null : Math.max(0, Math.round(update.durationMs));
  const p = update.partitions;

  await sql`
    INSERT INTO conditions.source_poll_attempt (
      source, attempted_at, finished_at, outcome, network_validated, published,
      active_event_count, inserted, updated, deleted, rejected, duration_ms,
      partitions_succeeded, partitions_failed, partitions_total, error
    ) VALUES (
      ${sourceId}, ${attemptedAt}, now(), ${outcome}, ${networkValidated}, ${publication != null},
      ${publication?.activeEvents ?? null}, ${publication?.inserted ?? null},
      ${publication?.updated ?? null}, ${publication?.deleted ?? null},
      ${publication?.rejected ?? null}, ${durationMs}, ${p?.succeeded ?? null},
      ${p?.failed ?? null}, ${p?.total ?? null}, ${error ?? null}
    )
  `;

  await sql`
    INSERT INTO conditions.source_status (
      source, last_attempt_at, last_success_at, last_network_success_at,
      freshness_deadline, last_publication_at, publication_revision, last_outcome,
      freshness_window_sec, last_row_count, active_event_count,
      last_inserted, last_updated, last_deleted, last_rejected, last_duration_ms,
      consecutive_failures, last_error, last_error_at, updated_at
    ) VALUES (
      ${sourceId}, ${attemptedAt}, ${networkValidated ? attemptedAt : null},
      ${networkValidated ? attemptedAt : null},
      ${networkValidated ? attemptedAt : null}::timestamptz + (${update.freshnessWindowSec} * interval '1 second'),
      ${publication ? attemptedAt : null}, ${publication ? 1 : 0}, ${outcome},
      ${update.freshnessWindowSec}, ${publication?.rowCount ?? publication?.activeEvents ?? null},
      ${publication?.activeEvents ?? null}, ${publication?.inserted ?? null},
      ${publication?.updated ?? null}, ${publication?.deleted ?? null},
      ${publication?.rejected ?? null}, ${durationMs}, ${outcome === "failed" ? 1 : 0},
      ${error ?? null}, ${error ? attemptedAt : null}, now()
    )
    ON CONFLICT (source) DO UPDATE SET
      last_attempt_at = GREATEST(conditions.source_status.last_attempt_at, excluded.last_attempt_at),
      last_outcome = CASE WHEN excluded.last_attempt_at >= conditions.source_status.last_attempt_at
        THEN excluded.last_outcome ELSE conditions.source_status.last_outcome END,
      freshness_window_sec = CASE WHEN excluded.last_attempt_at >= conditions.source_status.last_attempt_at
        THEN excluded.freshness_window_sec ELSE conditions.source_status.freshness_window_sec END,
      last_duration_ms = CASE WHEN excluded.last_attempt_at >= conditions.source_status.last_attempt_at
        THEN excluded.last_duration_ms ELSE conditions.source_status.last_duration_ms END,
      last_network_success_at = CASE WHEN excluded.last_network_success_at IS NOT NULL
        AND (conditions.source_status.last_network_success_at IS NULL
          OR excluded.last_network_success_at >= conditions.source_status.last_network_success_at)
        THEN excluded.last_network_success_at ELSE conditions.source_status.last_network_success_at END,
      last_success_at = CASE WHEN excluded.last_network_success_at IS NOT NULL
        AND (conditions.source_status.last_network_success_at IS NULL
          OR excluded.last_network_success_at >= conditions.source_status.last_network_success_at)
        THEN excluded.last_network_success_at ELSE conditions.source_status.last_success_at END,
      freshness_deadline = CASE WHEN excluded.last_network_success_at IS NOT NULL
        AND (conditions.source_status.last_network_success_at IS NULL
          OR excluded.last_network_success_at >= conditions.source_status.last_network_success_at)
        THEN excluded.freshness_deadline ELSE conditions.source_status.freshness_deadline END,
      last_publication_at = CASE WHEN excluded.last_publication_at IS NOT NULL
        AND (conditions.source_status.last_publication_at IS NULL
          OR excluded.last_publication_at >= conditions.source_status.last_publication_at)
        THEN excluded.last_publication_at ELSE conditions.source_status.last_publication_at END,
      publication_revision = conditions.source_status.publication_revision + CASE
        WHEN excluded.last_publication_at IS NOT NULL
          AND (conditions.source_status.last_publication_at IS NULL
            OR excluded.last_publication_at >= conditions.source_status.last_publication_at)
        THEN 1 ELSE 0 END,
      last_row_count = CASE WHEN excluded.last_publication_at IS NOT NULL
        AND (conditions.source_status.last_publication_at IS NULL
          OR excluded.last_publication_at >= conditions.source_status.last_publication_at)
        THEN excluded.last_row_count ELSE conditions.source_status.last_row_count END,
      active_event_count = CASE WHEN excluded.last_publication_at IS NOT NULL
        AND (conditions.source_status.last_publication_at IS NULL
          OR excluded.last_publication_at >= conditions.source_status.last_publication_at)
        THEN excluded.active_event_count ELSE conditions.source_status.active_event_count END,
      last_inserted = CASE WHEN excluded.last_publication_at IS NOT NULL
        AND (conditions.source_status.last_publication_at IS NULL OR excluded.last_publication_at >= conditions.source_status.last_publication_at)
        THEN excluded.last_inserted ELSE conditions.source_status.last_inserted END,
      last_updated = CASE WHEN excluded.last_publication_at IS NOT NULL
        AND (conditions.source_status.last_publication_at IS NULL OR excluded.last_publication_at >= conditions.source_status.last_publication_at)
        THEN excluded.last_updated ELSE conditions.source_status.last_updated END,
      last_deleted = CASE WHEN excluded.last_publication_at IS NOT NULL
        AND (conditions.source_status.last_publication_at IS NULL OR excluded.last_publication_at >= conditions.source_status.last_publication_at)
        THEN excluded.last_deleted ELSE conditions.source_status.last_deleted END,
      last_rejected = CASE WHEN excluded.last_publication_at IS NOT NULL
        AND (conditions.source_status.last_publication_at IS NULL OR excluded.last_publication_at >= conditions.source_status.last_publication_at)
        THEN excluded.last_rejected ELSE conditions.source_status.last_rejected END,
      consecutive_failures = CASE
        WHEN excluded.last_attempt_at < conditions.source_status.last_attempt_at THEN conditions.source_status.consecutive_failures
        WHEN excluded.last_outcome = 'failed' THEN conditions.source_status.consecutive_failures + 1
        WHEN excluded.last_network_success_at IS NOT NULL THEN 0
        ELSE conditions.source_status.consecutive_failures END,
      last_error = CASE
        WHEN excluded.last_attempt_at < conditions.source_status.last_attempt_at THEN conditions.source_status.last_error
        WHEN excluded.last_error IS NOT NULL THEN excluded.last_error
        WHEN excluded.last_network_success_at IS NOT NULL THEN NULL
        ELSE conditions.source_status.last_error END,
      last_error_at = CASE
        WHEN excluded.last_attempt_at < conditions.source_status.last_attempt_at THEN conditions.source_status.last_error_at
        WHEN excluded.last_error IS NOT NULL THEN excluded.last_attempt_at
        WHEN excluded.last_network_success_at IS NOT NULL THEN NULL
        ELSE conditions.source_status.last_error_at END,
      updated_at = now()
  `;

  await sql`DELETE FROM conditions.source_poll_attempt WHERE attempted_at < now() - interval '8 days'`;
}

export async function getLastRowCount(sql: Sql, sourceId: string): Promise<number | null> {
  const rows = await sql<{ last_row_count: number | null }[]>`
    SELECT last_row_count FROM conditions.source_status WHERE source = ${sourceId}
  `;
  return rows[0]?.last_row_count ?? null;
}

export async function readSourceOperationalStatus(
  sql: Sql
): Promise<Map<string, SourceOperationalStatus>> {
  const rows = await sql<
    {
      source: string;
      last_attempt_at: Date | string | null;
      last_network_success_at: Date | string | null;
      freshness_deadline: Date | string | null;
      last_publication_at: Date | string | null;
      publication_revision: number | string;
      last_outcome: SourcePollOutcome | null;
      active_event_count: number | null;
      last_inserted: number | null;
      last_updated: number | null;
      last_deleted: number | null;
      last_rejected: number | null;
      last_duration_ms: number | null;
      consecutive_failures: number;
      last_error: string | null;
      last_error_at: Date | string | null;
    }[]
  >`
    SELECT source, last_attempt_at, last_network_success_at, freshness_deadline,
      last_publication_at, publication_revision, last_outcome, active_event_count,
      last_inserted, last_updated, last_deleted, last_rejected, last_duration_ms,
      consecutive_failures, last_error, last_error_at FROM conditions.source_status
  `;
  return new Map(
    rows.map((row) => [
      row.source,
      {
        source: row.source,
        ...(iso(row.last_attempt_at) ? { lastAttemptAt: iso(row.last_attempt_at) } : {}),
        ...(iso(row.last_network_success_at)
          ? { lastNetworkSuccessAt: iso(row.last_network_success_at) }
          : {}),
        ...(iso(row.freshness_deadline) ? { freshnessDeadline: iso(row.freshness_deadline) } : {}),
        ...(iso(row.last_publication_at)
          ? { lastPublicationAt: iso(row.last_publication_at) }
          : {}),
        publicationRevision: Number(row.publication_revision),
        ...(row.last_outcome ? { lastOutcome: row.last_outcome } : {}),
        ...(row.active_event_count != null ? { activeEvents: row.active_event_count } : {}),
        ...(row.last_inserted != null ? { lastInserted: row.last_inserted } : {}),
        ...(row.last_updated != null ? { lastUpdated: row.last_updated } : {}),
        ...(row.last_deleted != null ? { lastDeleted: row.last_deleted } : {}),
        ...(row.last_rejected != null ? { lastRejected: row.last_rejected } : {}),
        ...(row.last_duration_ms != null ? { lastDurationMs: row.last_duration_ms } : {}),
        consecutiveFailures: row.consecutive_failures,
        ...(row.last_error ? { lastError: row.last_error } : {}),
        ...(iso(row.last_error_at) ? { lastErrorAt: iso(row.last_error_at) } : {}),
      },
    ])
  );
}
