import type { EvidenceEntry, EvidenceLedger } from "@openconditions/core";

/**
 * A single row from `conditions.report_evidence` — the authoritative,
 * append-only evidence ledger for a crowd record. This is the raw storage
 * shape; {@link evidenceRowsToLedger} maps it into core's replayable
 * {@link EvidenceEntry} model.
 */
export interface ReportEvidenceRow {
  id: string | number;
  evidenceKind: string;
  actorKeyId?: string | null;
  sourceId?: string | null;
  occurredAt: string;
  details?: unknown;
}

/**
 * Reads `details.outcome` off an unknown JSONB blob. "confirmed" is the default
 * ONLY when the outcome is genuinely absent (no details object, or a missing/
 * undefined `outcome` key). Any PRESENT value that is not exactly
 * "confirmed"/"rejected" is a corrupt ledger and throws — a mangled rejection
 * must never silently coerce into an official confirmation.
 */
function outcomeFromDetails(details: unknown, rowId: string | number): "confirmed" | "rejected" {
  const outcome =
    details !== null && typeof details === "object"
      ? (details as { outcome?: unknown }).outcome
      : undefined;
  if (outcome === undefined) {
    return "confirmed";
  }
  if (outcome === "confirmed" || outcome === "rejected") {
    return outcome;
  }
  throw new TypeError(
    `evidenceRowsToLedger: row ${String(rowId)} has unrecognized official_match ` +
      `details.outcome ${JSON.stringify(outcome)} (corrupt ledger)`,
  );
}

/**
 * When a report entry counts from: the instant the reporter states
 * (`details.reportedAt`), so a report uploaded late lives only what is left
 * of its lifetime, but never later than the server received it — the row's
 * own time, which a reporter cannot move.
 */
function reportedAt(row: ReportEvidenceRow): string {
  const stated =
    row.details !== null && typeof row.details === "object"
      ? (row.details as { reportedAt?: unknown }).reportedAt
      : undefined;
  if (typeof stated !== "string" || !Number.isFinite(Date.parse(stated))) return row.occurredAt;
  return Date.parse(stated) < Date.parse(row.occurredAt)
    ? new Date(Date.parse(stated)).toISOString()
    : row.occurredAt;
}

/**
 * Map the stored `report_evidence` rows for one record into core's
 * {@link EvidenceLedger}, the input to `evaluateEvidence`. The raw ledger stays
 * authoritative — this is a pure, deterministic projection, so re-running it on
 * the same rows always yields the same ledger.
 *
 * Mapping (fixed):
 * - `report`/`confirm`/`negate` map straight to the same core kind;
 * - `official_match` → external `{ source: "official" }`, its outcome read from
 *   `details.outcome` ("confirmed" when absent; any other present value throws);
 * - `reviewer_accept` → external `{ source: "reviewer", outcome: "confirmed" }`;
 * - `reviewer_reject` → external `{ source: "reviewer", outcome: "rejected" }`.
 *
 * Entry `id` is `String(row.id)`, `at` is `occurredAt` (a report's
 * {@link reportedAt}), and `reporterKey` is `actorKeyId ?? undefined`.
 *
 * @throws TypeError on an unknown `evidenceKind`, or on an official_match row
 *   whose present `details.outcome` is unrecognized — a corrupt ledger must
 *   fail loudly rather than silently drop or coerce evidence.
 */
export function evidenceRowsToLedger(rows: ReportEvidenceRow[], now: string): EvidenceLedger {
  const entries: EvidenceEntry[] = [];
  for (const row of rows) {
    const base = {
      id: String(row.id),
      at: row.occurredAt,
      reporterKey: row.actorKeyId ?? undefined,
    };
    switch (row.evidenceKind) {
      case "report":
        entries.push({ ...base, at: reportedAt(row), kind: "report" });
        break;
      case "confirm":
      case "negate":
        entries.push({ ...base, kind: row.evidenceKind });
        break;
      case "official_match":
        entries.push({
          ...base,
          kind: "external",
          external: { source: "official", outcome: outcomeFromDetails(row.details, row.id) },
        });
        break;
      case "reviewer_accept":
        entries.push({
          ...base,
          kind: "external",
          external: { source: "reviewer", outcome: "confirmed" },
        });
        break;
      case "reviewer_reject":
        entries.push({
          ...base,
          kind: "external",
          external: { source: "reviewer", outcome: "rejected" },
        });
        break;
      default:
        throw new TypeError(
          `evidenceRowsToLedger: unknown evidence_kind "${row.evidenceKind}" (corrupt ledger)`,
        );
    }
  }
  return { entries, now };
}
