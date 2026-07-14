/**
 * The release manifest: a VERSIONED, data-independent schedule fixed BEFORE any
 * data is inspected. It pins the tumbling (non-overlapping) time windows and the
 * public segment domain, and from those derives the fixed partition list the glue
 * iterates. Because the manifest is a pure function of its schedule config — never
 * of the data — feeding two different datasets to the glue yields the identical
 * manifest, the identical partition list, and the identical query count.
 *
 * "Tumbling" means the windows tile time without overlap: sliding/overlapping
 * windows would let a single contribution land in two released resolutions, so
 * they are rejected here by construction.
 */

/** A single non-overlapping release window (epoch). `endMs` is exclusive. */
export interface ReleaseWindow {
  windowId: string;
  startMs: number;
  endMs: number;
}

/** The versioned, data-independent release schedule. */
export interface ReleaseManifest {
  version: string;
  /** Public segment domain — fixed before data, not derived from observations. */
  segmentIds: readonly string[];
  /** Tumbling (non-overlapping) windows, sorted by start. */
  windows: readonly ReleaseWindow[];
}

/** One cell of the fixed partition grid: a `(segment, window)` pair. */
export interface Partition {
  segmentId: string;
  windowId: string;
}

export class OverlappingWindowError extends Error {
  constructor(reason: string) {
    super(`release windows must be tumbling (non-overlapping): ${reason}`);
    this.name = "OverlappingWindowError";
  }
}

export interface ReleaseManifestConfig {
  version: string;
  segmentIds: readonly string[];
  windows: readonly ReleaseWindow[];
}

/**
 * Builds a manifest from a schedule config, rejecting any window set that is not
 * tumbling. Windows are sorted by `startMs`; a window whose start precedes the
 * previous window's (exclusive) end overlaps and is refused. Zero-length or
 * inverted windows are refused too. The result is deterministic and depends only
 * on the config — never on data.
 */
export function buildReleaseManifest(config: ReleaseManifestConfig): ReleaseManifest {
  if (config.windows.length === 0) {
    throw new OverlappingWindowError("at least one window is required");
  }
  const sorted = [...config.windows].sort((a, b) => a.startMs - b.startMs);
  for (const w of sorted) {
    if (!(w.endMs > w.startMs)) {
      throw new OverlappingWindowError(
        `window "${w.windowId}" is empty or inverted (start ${w.startMs} >= end ${w.endMs})`
      );
    }
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i]!;
    if (seenIds.has(w.windowId)) {
      throw new OverlappingWindowError(`duplicate window id "${w.windowId}"`);
    }
    seenIds.add(w.windowId);
    if (i > 0) {
      const prev = sorted[i - 1]!;
      if (w.startMs < prev.endMs) {
        throw new OverlappingWindowError(
          `window "${w.windowId}" (start ${w.startMs}) overlaps "${prev.windowId}" (end ${prev.endMs})`
        );
      }
    }
  }
  const segmentIds = [...config.segmentIds].sort();
  if (segmentIds.length === 0) {
    throw new OverlappingWindowError("at least one segment is required in the public domain");
  }
  return { version: config.version, segmentIds, windows: sorted };
}

/**
 * The fixed partition grid: the cross-product of the public segment domain and
 * the tumbling windows, in a stable (segment, window) order. This is the exact
 * list the glue iterates, so its length is the query count and it never depends
 * on the data.
 */
export function listPartitions(manifest: ReleaseManifest): Partition[] {
  const partitions: Partition[] = [];
  for (const segmentId of manifest.segmentIds) {
    for (const window of manifest.windows) {
      partitions.push({ segmentId, windowId: window.windowId });
    }
  }
  return partitions;
}

/** Stable string key for a partition (used for logging, bounding, and dedup). */
export function partitionKey(partition: Partition): string {
  return `${partition.segmentId}\u0000${partition.windowId}`;
}

/** The window a timestamp falls in, or `undefined` if outside every window. */
export function windowForTimestamp(
  manifest: ReleaseManifest,
  timestampMs: number
): ReleaseWindow | undefined {
  return manifest.windows.find((w) => timestampMs >= w.startMs && timestampMs < w.endMs);
}
