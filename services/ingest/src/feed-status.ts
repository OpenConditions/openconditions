/** Latest run outcome for one feed. All timestamps are ISO 8601 strings. */
export interface FeedRunStatus {
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  lastRowCount?: number;
  lastDurationMs?: number;
}

/**
 * Per-instance, in-memory record of each feed's last run. Lives for the process
 * lifetime and is written by the scheduler after every cycle. An error never
 * clears the last-success fields, so an operator can see "last worked at X,
 * failing since Y".
 */
export class FeedStatusStore {
  private readonly map = new Map<string, FeedRunStatus>();

  recordSuccess(feedId: string, at: string, rowCount: number, durationMs: number): void {
    const prev = this.map.get(feedId) ?? {};
    this.map.set(feedId, {
      ...prev,
      lastRunAt: at,
      lastSuccessAt: at,
      lastRowCount: rowCount,
      lastDurationMs: durationMs,
    });
  }

  recordError(feedId: string, at: string, message: string): void {
    const prev = this.map.get(feedId) ?? {};
    this.map.set(feedId, { ...prev, lastRunAt: at, lastError: message, lastErrorAt: at });
  }

  get(feedId: string): FeedRunStatus | undefined {
    return this.map.get(feedId);
  }

  all(): Record<string, FeedRunStatus> {
    return Object.fromEntries(this.map);
  }
}
