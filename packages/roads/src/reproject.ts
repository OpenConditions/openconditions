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
  // RGF93 / Lambert-93 — French national road counting-station reference.
  "EPSG:2154":
    "+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 " +
    "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
  // ETRS89 / UTM zones 32N and 33N — the German national grids.
  "EPSG:25832":
    "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
  "EPSG:25833":
    "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs",
};

/**
 * German grids whose easting carries the UTM zone as a prefix (`33342865` is
 * zone 33, easting 342865) — EPSG:5650/5652 and their zone-32 counterparts.
 * proj4 has no notion of that prefix, so it is stripped before transforming.
 */
const ZONE_PREFIXED: Record<string, { zone: number; base: string }> = {
  "EPSG:5650": { zone: 33, base: "EPSG:25833" },
  "EPSG:5652": { zone: 32, base: "EPSG:25832" },
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
  if (!code || code === "EPSG:3857") return null;

  const prefixed = ZONE_PREFIXED[code];
  if (prefixed) {
    const { zone, base } = prefixed;
    return ([x, y]: [number, number]) =>
      proj4(base, "WGS84", [x - zone * 1_000_000, y]) as [number, number];
  }
  if (proj4.defs(code)) {
    return (p: [number, number]) => proj4(code, "WGS84", p) as [number, number];
  }
  return null;
}

/**
 * Whether a pair is a plausible WGS84 lon/lat.
 *
 * A feed publishing a projected grid without declaring it looks exactly like a
 * feed publishing degrees, right up until the numbers are stored — Mecklenburg-
 * Vorpommern sat at eastings near 33 000 000 in its latitude column for months.
 * Nothing downstream can recover from that, so the check belongs at the point
 * the coordinate is read.
 */
export function isPlausibleWgs84([lon, lat]: [number, number]): boolean {
  return (
    Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
  );
}
