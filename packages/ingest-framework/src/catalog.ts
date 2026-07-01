import { readFile, writeFile } from "node:fs/promises";
import type { FeedSourceBase } from "./feed-source.js";
import { guardedFetch } from "./egress.js";

/**
 * Expands a catalog/registry reference into concrete feeds. Fetches the registry
 * only through the injected `fetch` (so the egress guard applies) and returns full,
 * pure-data feed descriptors — never URLs alone — so the resolved set is
 * serialisable into the atlas and re-loadable from a data file.
 */
export interface CatalogResolver {
  id: string;
  resolve(fetchFn: typeof fetch): Promise<FeedSourceBase[]>;
  /** Absolute path to the vendored snapshot the export script writes on success. */
  snapshotPath: string;
  /**
   * Bundle-safe fallback set, imported as a JSON module so it survives being
   * inlined into a service bundle (where `snapshotPath` would resolve to the
   * wrong dist dir). Preferred over reading `snapshotPath` when a live resolve
   * fails.
   */
  snapshot?: FeedSourceBase[];
}

const byDomainId = new Map<string, CatalogResolver>();
const byId = new Map<string, CatalogResolver>();

const key = (domain: string, id: string): string => `${domain}:${id}`;

export function registerCatalogResolver(domain: string, r: CatalogResolver): void {
  if (byId.has(r.id)) {
    throw new Error(`catalog resolver "${r.id}" is already registered`);
  }
  byDomainId.set(key(domain, r.id), r);
  byId.set(r.id, r);
}

export function getCatalogResolver(domain: string, id: string): CatalogResolver {
  const r = byDomainId.get(key(domain, id));
  if (!r) throw new Error(`no catalog resolver "${id}" registered for domain "${domain}"`);
  return r;
}

export function getCatalogResolverById(id: string): CatalogResolver {
  const r = byId.get(id);
  if (!r) throw new Error(`no catalog resolver "${id}" registered`);
  return r;
}

/** Test-only: clears the registry between suites. */
export function __resetCatalogResolvers(): void {
  byDomainId.clear();
  byId.clear();
}

/**
 * Resolves a catalog live, refreshing the vendored snapshot on success and
 * falling back to it on failure (Transitland's git-submodule resilience). Never
 * throws: a dead registry with no snapshot degrades to an empty feed set so the
 * surrounding fan-out preserves last-good rows.
 *
 * On live failure the bundle-safe `resolver.snapshot` (a JSON module) is
 * preferred over reading `snapshotPath`, because a bundled resolver's
 * `snapshotPath` resolves relative to the service bundle, not this package.
 */
export async function resolveWithSnapshot(
  resolver: CatalogResolver,
  fetchFn: typeof fetch = guardedFetch()
): Promise<FeedSourceBase[]> {
  try {
    const feeds = await resolver.resolve(fetchFn);
    try {
      await writeFile(resolver.snapshotPath, `${JSON.stringify(feeds, null, 2)}\n`);
    } catch (writeErr) {
      console.warn(
        `[catalog] ${resolver.id}: could not refresh snapshot ${resolver.snapshotPath}:`,
        writeErr instanceof Error ? writeErr.message : writeErr
      );
    }
    return feeds;
  } catch (liveErr) {
    const why = liveErr instanceof Error ? liveErr.message : String(liveErr);
    try {
      const snapshot =
        resolver.snapshot ??
        (JSON.parse(await readFile(resolver.snapshotPath, "utf8")) as FeedSourceBase[]);
      console.warn(
        `[catalog] ${resolver.id}: live resolve failed (${why}); using vendored snapshot`
      );
      return snapshot;
    } catch (snapErr) {
      console.error(
        `[catalog] ${resolver.id}: live resolve failed (${why}) and no usable snapshot at ${resolver.snapshotPath}:`,
        snapErr instanceof Error ? snapErr.message : snapErr
      );
      return [];
    }
  }
}
