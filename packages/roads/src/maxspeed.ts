const MPH_TO_KPH = 1.609344;

/**
 * Parse an OSM `maxspeed` tag value to km/h. Accepts a bare number (km/h), an
 * "N mph" value, or "N km/h"; returns null for non-numeric zone codes
 * (e.g. "RO:urban", "none", "walk"). Never throws.
 */
export function parseMaxspeedKph(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /mph/i.test(m[2] ?? "") ? n * MPH_TO_KPH : n;
}
