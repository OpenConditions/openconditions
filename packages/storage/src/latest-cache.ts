/**
 * What a series' latest row held when a committed write of this process
 * last wrote or read it: as much as the next poll needs to tell its reading
 * unchanged without reading the row back.
 */
export interface LatestEntry {
  seriesId: number;
  /** The content hash of the reading in effect. */
  contentHash: string;
  /**
   * For a polled change-only series, a digest of what a reading restating
   * the one in effect matches: its result, credit and baseline.
   */
  restates?: string;
  /** When the reading in effect took effect, ms since the epoch. */
  effectiveFrom: number;
  /** When it expires, ms since the epoch; null when it states no expiry. */
  expiresAt: number | null;
  /** It states a `validUntil`: for a polled series, a complete poll ended it. */
  ended: boolean;
}

/**
 * About 500 bytes an entry, its key included (measured: 98 MB for 200,000
 * charge points): at most about 120 MB.
 */
export const LATEST_CACHE_ENTRIES = 250_000;

/**
 * The latest rows of the series this process writes, as {@link LatestEntry}
 * entries keyed as a write keys its series. Only an accelerator: a write
 * checks every entry it relies on against the row (see `writeObservationsIn`),
 * and a series without one is read as without the cache. It holds at most
 * `capacity` entries, dropping those a committed write saw least recently.
 */
export class LatestCache {
  readonly #entries = new Map<string, LatestEntry>();

  constructor(readonly capacity: number = LATEST_CACHE_ENTRIES) {}

  get size(): number {
    return this.#entries.size;
  }

  /** A write's view of the cache: what it learns takes effect when its transaction commits. */
  begin(): LatestCacheWrite {
    const entries = this.#entries;
    const staged = new Map<string, LatestEntry | null>();
    const seen = new Set<string>();
    const touch = (key: string, entry: LatestEntry) => {
      entries.delete(key);
      entries.set(key, entry);
    };
    return {
      get: (key) => entries.get(key),
      set: (key, entry) => staged.set(key, entry),
      delete: (key) => staged.set(key, null),
      seen: (key) => seen.add(key),
      commit: () => {
        for (const key of seen) {
          const entry = entries.get(key);
          if (entry !== undefined && !staged.has(key)) touch(key, entry);
        }
        for (const [key, entry] of staged) {
          if (entry === null) entries.delete(key);
          else touch(key, entry);
        }
        for (const key of entries.keys()) {
          if (entries.size <= this.capacity) break;
          entries.delete(key);
        }
      },
      // A rolled-back write may have changed none of its rows: what it wrote is forgotten.
      discard: () => {
        for (const key of staged.keys()) entries.delete(key);
      },
    };
  }
}

/** One write's use of a {@link LatestCache}. */
export interface LatestCacheWrite {
  /** The entry committed writes left for a series. */
  get(key: string): LatestEntry | undefined;
  /** The series' row as this write leaves it. */
  set(key: string, entry: LatestEntry): void;
  /** This write leaves the series' row in a state the cache does not hold. */
  delete(key: string): void;
  /** This write found the series' row as its entry says. */
  seen(key: string): void;
  /** The write's transaction committed. */
  commit(): void;
  /** The write's transaction rolled back. */
  discard(): void;
}
