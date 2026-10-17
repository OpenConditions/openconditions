/**
 * Per-source counters for what a parser deliberately left unread, by reason.
 *
 * A parser that drops a record, or ignores a value it cannot read, produces
 * nothing a status page could show: a feed losing its every closure to an
 * unsupported location reference, or to a renamed enum value, looks exactly
 * like a healthy, quiet feed. Recording each skip under its reason makes the
 * loss measurable in `GET /feeds/status`.
 *
 * Counts accumulate across a run's buffers (a multi-URL feed parses several)
 * and are drained by the pipeline once, after parsing.
 */

/**
 * Why a source record produced nothing. The pipeline counts these records
 * among the run's rejected ones, so a format records them here instead of in
 * its `ParseOutput.rejected`.
 *
 * - `no_geometry`: no usable coordinates (an Alert-C/TMC-only location, a null geometry).
 * - `unknown_type`: a record type, event type or class the format does not map.
 * - `malformed`: the record breaks the format's own rules (a missing required
 *   field, an unparseable value in a field the record cannot do without).
 * - `unsupported_version`: a document or record in a version of the format the
 *   parser does not read.
 */
export const RECORD_SKIP_REASONS = [
  "no_geometry",
  "unknown_type",
  "malformed",
  "unsupported_version",
] as const;

/**
 * Why a value of a record that was kept went unread: `unknown_value` is an
 * enumerated value the format does not map, which the record is published
 * without.
 */
export const VALUE_SKIP_REASONS = ["unknown_value"] as const;

export type RecordSkipReason = (typeof RECORD_SKIP_REASONS)[number];
export type SkipReason = RecordSkipReason | (typeof VALUE_SKIP_REASONS)[number];

/** A run's skips by reason; a reason with nothing skipped is absent. */
export type SkipCounts = Partial<Record<SkipReason, number>>;

const bySource = new Map<string, SkipCounts>();

/** Add to a source's count of skips for one reason in the current run. */
export function recordSkipped(sourceId: string, reason: SkipReason, count = 1): void {
  if (count <= 0) return;
  const counts = bySource.get(sourceId) ?? {};
  counts[reason] = (counts[reason] ?? 0) + count;
  bySource.set(sourceId, counts);
}

/**
 * Read and clear a source's accumulated counts. Draining keeps each run's
 * numbers independent: a status page showing a monotonically growing total
 * would say nothing about whether the loss is still happening.
 */
export function drainSkipped(sourceId: string): SkipCounts {
  const counts = bySource.get(sourceId) ?? {};
  bySource.delete(sourceId);
  return counts;
}

/** The source records the counts say were dropped, value-level skips excluded. */
export function skippedRecords(counts: SkipCounts): number {
  return RECORD_SKIP_REASONS.reduce((sum, reason) => sum + (counts[reason] ?? 0), 0);
}

/** Two runs' or two parses' counts summed per reason. */
export function addSkips(a: SkipCounts, b: SkipCounts): SkipCounts {
  const out: SkipCounts = { ...a };
  for (const [reason, count] of Object.entries(b) as [SkipReason, number][]) {
    if (count > 0) out[reason] = (out[reason] ?? 0) + count;
  }
  return out;
}

/** Test seam: forget every counter. */
export function __resetSkips(): void {
  bySource.clear();
}
