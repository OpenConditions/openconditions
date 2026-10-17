import { redactUrl, type SkipCounts } from "@openconditions/ingest-framework";

/** Latest run outcome for one feed. All timestamps are ISO 8601 strings. */
export interface FeedRunStatus {
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  lastRowCount?: number;
  lastDurationMs?: number;
  /**
   * What the last run's parser left unread, by reason: records dropped for want
   * of coordinate geometry (`no_geometry`, such as DATEX Alert-C/TMC-only
   * location references), of an unmapped type (`unknown_type`), as malformed
   * (`malformed`) or in an unsupported version (`unsupported_version`), and
   * enumerated values it could not map (`unknown_value`). Absent when the run
   * skipped nothing, so a feed that never loses data stays visually quiet.
   */
  lastSkipped?: SkipCounts;
}

/**
 * Per-instance, in-memory record of each feed's last run. Lives for the process
 * lifetime and is written by the scheduler after every cycle. An error never
 * clears the last-success fields, so an operator can see "last worked at X,
 * failing since Y".
 */
export class FeedStatusStore {
  private readonly map = new Map<string, FeedRunStatus>();

  recordSuccess(
    feedId: string,
    at: string,
    rowCount: number,
    durationMs: number,
    skipped?: SkipCounts,
  ): void {
    const prev = this.map.get(feedId) ?? {};
    this.map.set(feedId, {
      ...prev,
      lastRunAt: at,
      lastSuccessAt: at,
      lastRowCount: rowCount,
      lastDurationMs: durationMs,
      // Always overwritten (not merged), so a run that dropped nothing clears a
      // previous run's count instead of leaving a stale number on the page.
      lastSkipped: skipped,
      // A genuine success means the feed recovered — a stale error from a prior
      // cycle should not keep showing on GET /feeds/status.
      lastError: undefined,
      lastErrorAt: undefined,
    });
  }

  recordError(feedId: string, at: string, message: string): void {
    const prev = this.map.get(feedId) ?? {};
    const scrubbed = message.replace(/https?:\/\/\S+/g, (m) => redactUrl(m));
    this.map.set(feedId, { ...prev, lastRunAt: at, lastError: scrubbed, lastErrorAt: at });
  }

  get(feedId: string): FeedRunStatus | undefined {
    return this.map.get(feedId);
  }

  all(): Record<string, FeedRunStatus> {
    return Object.fromEntries(this.map);
  }
}
