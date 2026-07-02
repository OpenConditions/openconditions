import type { SiteGeometry } from "./siteTable.js";

interface Site {
  Id?: unknown;
  Longitude?: unknown;
  Latitude?: unknown;
}

/**
 * Build a WebTRIS site-Id → Point map from the `/api/v1.0/sites` registry
 * response. The id is stringified the same way `parseWebtrisFlow`'s
 * `siteToken` produces its join key, so the two maps join on matching keys.
 */
export function parseWebtrisSites(input: string | Buffer): Map<string, SiteGeometry> {
  const map = new Map<string, SiteGeometry>();
  let payload: { sites?: unknown };
  try {
    payload = JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : input);
  } catch {
    return map;
  }
  if (!Array.isArray(payload.sites)) return map;
  for (const s of payload.sites as Site[]) {
    if (s?.Id == null) continue;
    const lon = Number(s.Longitude);
    const lat = Number(s.Latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    map.set(String(s.Id), { type: "Point", coordinates: [lon, lat] });
  }
  return map;
}
