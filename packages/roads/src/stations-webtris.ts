import type { FlowSite, FlowSites } from "./flow-output.js";

interface Site {
  Id?: unknown;
  Name?: unknown;
  Longitude?: unknown;
  Latitude?: unknown;
}

/**
 * Build the WebTRIS sites (point and name) from the `/api/v1.0/sites` registry
 * response. The id is stringified the same way `parseWebtrisFlow`'s
 * `siteToken` produces its join key, so the two maps join on matching keys.
 */
export function parseWebtrisSites(input: string | Buffer): FlowSites {
  const map = new Map<string, FlowSite>();
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
    const name = typeof s.Name === "string" && s.Name.trim() ? s.Name.trim() : undefined;
    map.set(String(s.Id), {
      geometry: { type: "Point", coordinates: [lon, lat] },
      ...(name !== undefined ? { name } : {}),
    });
  }
  return map;
}
