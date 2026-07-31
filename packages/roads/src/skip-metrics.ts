/**
 * Per-source counters for records a parser deliberately dropped.
 *
 * DATEX providers publish a share of their records with Alert-C/TMC location
 * references and no coordinates. Those are skipped (there is no resolver yet),
 * which was previously visible only as one `console.debug` line — so a source
 * losing, say, its every closure to TMC-only encoding looked like a healthy,
 * quiet feed. Recording per source makes the loss measurable in
 * `GET /feeds/status`, which is what sizes the work of building a resolver.
 *
 * Counts accumulate across a run's buffers (a multi-URL feed parses several)
 * and are drained by the pipeline once, after parsing.
 */
const noGeometryBySource = new Map<string, number>();

/** Add to a source's dropped-for-lack-of-geometry count for the current run. */
export function recordSkippedNoGeometry(sourceId: string, count: number): void {
  if (count <= 0) return;
  noGeometryBySource.set(sourceId, (noGeometryBySource.get(sourceId) ?? 0) + count);
}

/**
 * Read and clear a source's accumulated count. Draining keeps each run's number
 * independent — a status page showing a monotonically growing total would say
 * nothing about whether the loss is still happening.
 */
export function drainSkippedNoGeometry(sourceId: string): number {
  const count = noGeometryBySource.get(sourceId) ?? 0;
  noGeometryBySource.delete(sourceId);
  return count;
}

/** Test seam: forget every counter. */
export function __resetSkipMetrics(): void {
  noGeometryBySource.clear();
}
