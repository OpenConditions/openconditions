import proj4 from "proj4";

/**
 * Coordinate reprojection to WGS84 for feeds published in a projected CRS.
 *
 * Web Mercator is a closed form (no datum shift); national Lambert grids need a
 * proper datum-aware transform, so proj4 is used with explicit `+towgs84`
 * parameters (a missing/wrong datum shift would silently misplace points by
 * 100–400 m). Definitions are registered for the grids we actually ingest;
 * extend `EPSG_DEFS` as new ones appear.
 */

const WEB_MERCATOR_R = 6_378_137;

/** Web Mercator (EPSG:3857) [x,y] metres → WGS84 [lon,lat] (closed form). */
export function mercToWgs84([x, y]: [number, number]): [number, number] {
  const lon = (x / WEB_MERCATOR_R) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / WEB_MERCATOR_R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/** proj4 definitions (with datum shifts) for the projected grids feeds use. */
const EPSG_DEFS: Record<string, string> = {
  // Belgian Lambert 2008 (ETRS89-based, no datum shift) — Brussels Mobility.
  "EPSG:3812":
    "+proj=lcc +lat_0=50.797815 +lon_0=4.35921583333333 +lat_1=49.8333333333333 " +
    "+lat_2=51.1666666666667 +x_0=649328 +y_0=665262 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
  // Belgian Lambert 72 (BD72) — Flanders Verkeerscentrum.
  "EPSG:31370":
    "+proj=lcc +lat_0=90 +lon_0=4.36748666666667 +lat_1=51.1666672333333 +lat_2=49.8333339 " +
    "+x_0=150000.013 +y_0=5400088.438 +ellps=intl " +
    "+towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs +type=crs",
  // ETRS89 / UTM zone 30N — City of Madrid INFORMO sensors (no datum shift).
  "EPSG:25830":
    "+proj=utm +zone=30 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
};
for (const [code, def] of Object.entries(EPSG_DEFS)) proj4.defs(code, def);

/** Extract a normalised "EPSG:<code>" from any CRS name form, else null. */
export function epsgCode(crsName: unknown): string | null {
  if (typeof crsName !== "string") return null;
  if (/CRS84|:4326\b|EPSG::?4326\b/.test(crsName)) return null; // already WGS84 lon/lat
  const m = crsName.match(/(\d{4,6})\s*$/);
  return m ? `EPSG:${m[1]}` : null;
}

/**
 * A coordinate transform `[x,y] → [lon,lat]` for a CRS name, or null when the
 * data is already WGS84 (or the CRS is unknown — caller leaves coords as-is).
 */
export function reprojectorFor(
  crsName: unknown
): ((p: [number, number]) => [number, number]) | null {
  if (typeof crsName !== "string" || crsName.length === 0) return null;
  if (/(?:^|[:/])(3857|900913|102100)\b/.test(crsName)) return mercToWgs84;
  const code = epsgCode(crsName);
  if (code && code !== "EPSG:3857" && proj4.defs(code)) {
    return (p: [number, number]) => proj4(code, "WGS84", p) as [number, number];
  }
  return null;
}
