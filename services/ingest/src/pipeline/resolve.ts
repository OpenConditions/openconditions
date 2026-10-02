import type { GeoJsonGeometry } from "@openconditions/core";
import type { RecordDraft } from "@openconditions/ingest-framework";
import type { MapMatchClient } from "@openconditions/openlr";
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

type Location = Record<string, unknown>;

const locationOf = (draft: RecordDraft) => draft["location"] as Location | undefined;

function extentOf(geometry: GeoJsonGeometry): string {
  return geometry.type.includes("Polygon")
    ? "area"
    : geometry.type.includes("LineString")
      ? "linear"
      : "point";
}

/** The draft placed on its decoded OpenLR geometry. */
function placed(draft: RecordDraft, geometry: GeoJsonGeometry): RecordDraft {
  return {
    ...draft,
    location: {
      ...locationOf(draft),
      geometry,
      extent: extentOf(geometry),
      geometryOrigin: "openlr_decoded",
    },
  };
}

/**
 * Places the drafts whose location is only an OpenLR reference.
 *
 * - A draft with geometry passes through unchanged.
 * - A draft with `location.openlr` and no geometry is resolved through the
 *   map-match client; on success it carries the decoded geometry
 *   (`geometryOrigin: openlr_decoded`), on a miss it is dropped and counted.
 *   A transport or validation failure also counts in `failed`: the caller
 *   must keep its last good snapshot rather than publish a partial one.
 * - Without a client (`OPENLR_RESOLVER_URL` unset) such drafts are dropped.
 *
 * `unlocatable` names every dropped situation, so a complete-snapshot source
 * can tell "gone upstream" apart from "we failed to place it".
 */
export async function resolveOpenLr(
  drafts: readonly RecordDraft[],
  client: MapMatchClient | null,
): Promise<{
  resolved: RecordDraft[];
  dropped: number;
  failed: number;
  unlocatable: string[];
}> {
  const resolved: RecordDraft[] = [];
  const unlocatable: string[] = [];
  let failed = 0;
  const needsResolve: { draft: RecordDraft; openlr: string }[] = [];

  for (const draft of drafts) {
    const location = locationOf(draft);
    const openlr = location?.["openlr"];
    if (location?.["geometry"] != null) resolved.push(draft);
    else if (typeof openlr === "string" && openlr.length > 0) needsResolve.push({ draft, openlr });
    else unlocatable.push(String(draft["id"]));
  }
  if (needsResolve.length > 0 && client === null) {
    console.warn(
      `[resolve] dropped ${needsResolve.length} OpenLR situation(s): OPENLR_RESOLVER_URL not set`,
    );
    for (const { draft } of needsResolve) unlocatable.push(String(draft["id"]));
    return { resolved, dropped: unlocatable.length, failed, unlocatable };
  }

  const results: Array<RecordDraft | null> = new Array(needsResolve.length).fill(null);
  let cursor = 0;
  // Concurrent workers with the same reference share one resolver call.
  const inFlight = new Map<string, Promise<GeoJsonGeometry | null>>();

  async function resolveOne(openlr: string, id: string): Promise<GeoJsonGeometry | null> {
    const inProgress = inFlight.get(openlr);
    if (inProgress !== undefined) return inProgress;
    const promise = (async (): Promise<GeoJsonGeometry | null> => {
      const geom = await client!.resolve(decodeOpenLrBinary(openlr));
      if (geom === null) {
        console.warn(`[resolve] no map-match for OpenLR situation ${id} — dropped`);
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
    while (cursor < needsResolve.length && failed === 0) {
      const idx = cursor++;
      const { draft, openlr } = needsResolve[idx]!;
      const cached = cache.get(openlr);
      if (cached !== undefined) {
        results[idx] = placed(draft, cached);
        continue;
      }
      try {
        const geom = await resolveOne(openlr, String(draft["id"]));
        results[idx] = geom !== null ? placed(draft, geom) : null;
      } catch (err) {
        failed++;
        console.warn(
          `[resolve] resolution failed for situation ${String(draft["id"])}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(RESOLVE_CONCURRENCY, needsResolve.length) }, () => worker()),
  );
  results.forEach((r, index) => {
    if (r !== null) resolved.push(r);
    else unlocatable.push(String(needsResolve[index]!.draft["id"]));
  });
  return { resolved, dropped: unlocatable.length, failed, unlocatable };
}

/** Exposed for testing — clears the in-process resolution cache. */
export function clearResolveCache(): void {
  cache.clear();
}
