import type { GeoJsonGeometry, Observation } from "@openconditions/core";
import type { MapMatchClient } from "@openconditions/openlr";
import type { UnresolvedRoadEvent } from "@openconditions/roads";
import { decodeOpenLrBinary } from "@openconditions/openlr";

/** Max cached resolutions — oldest entries are evicted when full. */
const CACHE_MAX = 2_000;

/** Bounded in-process resolution cache keyed by OpenLR base64 string. */
const cache = new Map<string, GeoJsonGeometry>();

function cacheSet(key: string, value: GeoJsonGeometry): void {
  if (cache.size >= CACHE_MAX) {
    // Evict the oldest inserted entry (Map preserves insertion order).
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, value);
}

/** Max concurrent resolver calls in flight at once. */
const RESOLVE_CONCURRENCY = 8;

/**
 * Resolves any observations that carry an OpenLR reference but no geometry.
 *
 * - Observations that already have geometry pass through unchanged.
 * - UnresolvedRoadEvent items (geometry absent, externalRefs.openlr set) are
 *   resolved via the map-match client; on success the resolved geometry is
 *   applied, yielding a full Observation; on failure (null return or thrown
 *   error) the item is dropped and the dropped counter is incremented.
 * - When `client` is null (OPENLR_RESOLVER_URL unset) unresolved items are
 *   dropped silently.
 *
 * Returns the filtered+resolved array (real geometry only) and the count of
 * dropped events. After this stage every item in `resolved` has a geometry
 * field — UnresolvedRoadEvent never reaches write-postgis.
 */
export async function resolveOpenLr(
  items: (Observation | UnresolvedRoadEvent)[],
  client: MapMatchClient | null
): Promise<{ resolved: Observation[]; dropped: number }> {
  const out: Observation[] = [];
  let dropped = 0;

  const passThrough: Observation[] = [];
  const needsResolve: UnresolvedRoadEvent[] = [];

  for (const item of items) {
    if (item.geometry != null) {
      passThrough.push(item as Observation);
    } else if ((item as UnresolvedRoadEvent).externalRefs?.openlr) {
      needsResolve.push(item as UnresolvedRoadEvent);
    } else {
      dropped++;
    }
  }

  out.push(...passThrough);

  if (needsResolve.length === 0) {
    return { resolved: out, dropped };
  }

  if (client === null) {
    dropped += needsResolve.length;
    console.warn(
      `[resolve] dropped ${needsResolve.length} OpenLR observation(s): OPENLR_RESOLVER_URL not set`
    );
    return { resolved: out, dropped };
  }

  const results: Array<Observation | null> = new Array(needsResolve.length).fill(null);
  let cursor = 0;

  // Tracks in-flight resolutions by openlr string so concurrent workers with
  // the same key share a single resolver call rather than issuing duplicates.
  const inFlight = new Map<string, Promise<GeoJsonGeometry | null>>();

  async function resolveOne(openlr: string, obsId: string): Promise<GeoJsonGeometry | null> {
    const inProgress = inFlight.get(openlr);
    if (inProgress !== undefined) return inProgress;

    const promise = (async (): Promise<GeoJsonGeometry | null> => {
      const loc = decodeOpenLrBinary(openlr);
      const geom = await client!.resolve(loc);
      if (geom === null) {
        console.warn(`[resolve] no map-match for OpenLR observation ${obsId} — dropped`);
        return null;
      }
      cacheSet(openlr, geom);
      return geom;
    })();

    inFlight.set(openlr, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(openlr);
    }
  }

  async function worker(): Promise<void> {
    while (cursor < needsResolve.length) {
      const idx = cursor++;
      const obs = needsResolve[idx]!;
      const openlr = obs.externalRefs!.openlr!;

      const cached = cache.get(openlr);
      if (cached !== undefined) {
        results[idx] = { ...obs, geometry: cached } as Observation;
        continue;
      }

      try {
        const geom = await resolveOne(openlr, obs.id);
        results[idx] = geom !== null ? ({ ...obs, geometry: geom } as Observation) : null;
      } catch (err) {
        console.warn(
          `[resolve] resolution failed for observation ${obs.id}:`,
          err instanceof Error ? err.message : err
        );
        results[idx] = null;
      }
    }
  }

  const workerCount = Math.min(RESOLVE_CONCURRENCY, needsResolve.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  for (const r of results) {
    if (r !== null) {
      out.push(r);
    } else {
      dropped++;
    }
  }

  return { resolved: out, dropped };
}

/** Exposed for testing — clears the in-process resolution cache. */
export function clearResolveCache(): void {
  cache.clear();
}
