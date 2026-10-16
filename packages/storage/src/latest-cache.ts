import { getHeapStatistics } from "node:v8";

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

/** An entry's heap, its key included (measured: 98 MB for 200,000 charge points). */
export const LATEST_ENTRY_BYTES = 500;

/** The share of the heap the process may grow to that the cache may hold. */
export const LATEST_CACHE_HEAP_SHARE = 0.08;

/** A source no poll has committed for this long is released. */
export const LATEST_CACHE_IDLE_MS = 2 * 3_600_000;

/** The entries {@link LATEST_CACHE_HEAP_SHARE} of a heap limit holds. */
export function latestCacheBudget(heapLimit = getHeapStatistics().heap_size_limit): number {
  return Math.floor((heapLimit * LATEST_CACHE_HEAP_SHARE) / LATEST_ENTRY_BYTES);
}

/**
 * The cache's budget in entries: `OPENCONDITIONS_LATEST_CACHE_MB` megabytes
 * of entries (0 turns the cache off), else {@link latestCacheBudget}.
 */
export function latestCacheBudgetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  heapLimit = getHeapStatistics().heap_size_limit,
): number {
  const raw = env["OPENCONDITIONS_LATEST_CACHE_MB"];
  const mb = raw == null || raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(mb) && mb >= 0
    ? Math.floor((mb * 1e6) / LATEST_ENTRY_BYTES)
    : latestCacheBudget(heapLimit);
}

/** A cached source: its series' entries, and when a poll of it last committed. */
interface CachedSource {
  entries: Map<string, LatestEntry>;
  at: number;
}

/**
 * The latest rows of the series this process writes, as {@link LatestEntry}
 * entries per source, keyed as a write keys its series. Only an accelerator:
 * a write checks every entry it relies on against the row (see
 * `writeObservationsIn`), and a series without one is read as without the
 * cache.
 *
 * A poll cycles through all of its source's series, so a source is cached
 * whole or not at all: a share of it would be evicted before its next poll
 * comes back to it. A source is held as its last committed poll left it
 * (what that poll saw or wrote), and taken only if all of it fits the
 * budget the sources already held leave, in the order their polls commit.
 * One that does not fit is not cached, said once, and tried again when the
 * budget it lacked frees up: a source shrinks, or one no poll has committed
 * for {@link LATEST_CACHE_IDLE_MS} is released.
 */
export class LatestCache {
  readonly #sources = new Map<string, CachedSource>();
  /** Sources refused, with the series they needed. */
  readonly #refused = new Map<string, number>();
  readonly #log: (message: string) => void;
  readonly #now: () => number;

  constructor(
    readonly budget: number = latestCacheBudgetFromEnv(),
    opts: { log?: (message: string) => void; now?: () => number } = {},
  ) {
    this.#log = opts.log ?? ((message) => console.warn(message));
    this.#now = opts.now ?? Date.now;
  }

  /** The entries the cache holds. */
  get size(): number {
    let size = 0;
    for (const { entries } of this.#sources.values()) size += entries.size;
    return size;
  }

  /** The entries the cache holds of a source. */
  sizeOf(sourceId: string): number {
    return this.#sources.get(sourceId)?.entries.size ?? 0;
  }

  /** A write's view of a source: what it learns takes effect when its transaction commits. */
  begin(sourceId: string): LatestCacheWrite {
    const now = this.#now();
    for (const [id, source] of this.#sources) {
      if (now - source.at >= LATEST_CACHE_IDLE_MS) this.#sources.delete(id);
    }
    const held = this.#sources.get(sourceId)?.entries ?? new Map<string, LatestEntry>();
    const needed = this.#refused.get(sourceId);
    if (needed !== undefined && needed > this.#free(sourceId)) return UNCACHED;
    const staged = new Map<string, LatestEntry | null>();
    const seen = new Set<string>();
    return {
      get: (key) => held.get(key),
      set: (key, entry) => staged.set(key, entry),
      delete: (key) => staged.set(key, null),
      seen: (key) => seen.add(key),
      commit: () => {
        const entries = new Map<string, LatestEntry>();
        for (const key of seen) {
          const entry = held.get(key);
          if (entry !== undefined && !staged.has(key)) entries.set(key, entry);
        }
        for (const [key, entry] of staged) if (entry !== null) entries.set(key, entry);
        this.#sources.delete(sourceId);
        const free = this.#free(sourceId);
        if (entries.size > free) {
          if (!this.#refused.has(sourceId)) {
            this.#log(
              `[ingest] ${sourceId}: ${entries.size} series exceed the latest cache's remaining ` +
                `${free} of ${this.budget} entries; its readings are read back every poll`,
            );
          }
          this.#refused.set(sourceId, entries.size);
          return;
        }
        this.#refused.delete(sourceId);
        if (entries.size > 0) this.#sources.set(sourceId, { entries, at: this.#now() });
      },
      // A rolled-back write may have changed none of its rows: what it wrote is forgotten.
      discard: () => {
        for (const key of staged.keys()) held.delete(key);
      },
    };
  }

  /** The entries the budget leaves a source beside the other sources held. */
  #free(sourceId: string): number {
    let used = 0;
    for (const [id, { entries }] of this.#sources) if (id !== sourceId) used += entries.size;
    return Math.max(0, this.budget - used);
  }
}

/** The view of a source the cache does not hold: nothing to read, nothing kept. */
const UNCACHED: LatestCacheWrite = {
  get: () => undefined,
  set: () => {},
  delete: () => {},
  seen: () => {},
  commit: () => {},
  discard: () => {},
};

/** One write's use of a {@link LatestCache}, for one source. */
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
