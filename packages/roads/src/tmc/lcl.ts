/**
 * Reader for the ISO 14819-3 TMC location-table exchange format (the `*.DAT`
 * files national road authorities publish alongside their Location Code List).
 *
 * Only the parts needed to turn an Alert-C reference into geometry are read:
 * the coded points and their coordinates, and the chain linking each point to
 * its neighbours along the road. Names, administrative areas and diversions are
 * deliberately ignored — they would multiply the vendored table's size without
 * changing where an event is drawn.
 *
 * The format is semicolon-delimited with a header row, CRLF line endings and a
 * UTF-8 BOM. Coordinates are signed integers in units of 1e-5 degrees WGS84.
 */

/** One coded location, with its neighbours along the road it belongs to. */
export interface TmcPoint {
  lon: number;
  lat: number;
  /** Next coded location in the road's positive direction, if any. */
  pos?: number;
  /** Previous coded location, i.e. the negative direction, if any. */
  neg?: number;
  /**
   * The road this location sits on, as the table numbers it ("A7", "B462").
   *
   * Carried so a resolution can be checked against the road a record claims to
   * be about. That check is what makes a code from another table edition usable
   * at all: agreement is evidence the code still means the same place, and
   * disagreement catches exactly the renumbering that would otherwise put an
   * incident on the wrong road.
   */
  road?: string;
}

/**
 * A location table for exactly one (country, table) pair at one version.
 *
 * `version` is load-bearing rather than descriptive: location codes are
 * renumbered between table versions, so resolving a record against the wrong
 * version silently yields a plausible coordinate on the wrong road. Callers are
 * expected to match it against what a feed declares.
 */
export interface TmcLocationTable {
  /** Numeric country id (ISO 14819-3 CID, e.g. 58 for Germany). */
  cid: number;
  /** Table code within the country (TABCD). */
  tabcd: number;
  version: string;
  /** Alphabetic country code (`CCD`, e.g. "D") — how some feeds name the country. */
  ccd?: string;
  /** Extended country code (`ECC`, e.g. "E0"). */
  ecc?: string;
  attribution?: string;
  license?: string;
  points: Map<number, TmcPoint>;
}

/** The vendored, JSON-serializable form of a table. */
export interface TmcTableSnapshot {
  cid: number;
  tabcd: number;
  version: string;
  ccd?: string;
  ecc?: string;
  attribution: string;
  license: string;
  /**
   * `[lcd, lon, lat, pos, neg, road]`; `pos`/`neg` are 0 when the point has no
   * link, `road` an empty string when the table names none.
   */
  points: [number, number, number, number, number, string][];
}

/** Rows of a `*.DAT` file, keyed by the header row's column names. */
export function parseDatFile(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split(";");
  const rows: Record<string, string>[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split(";");
    const row: Record<string, string> = {};
    cols.forEach((c, i) => (row[c] = (cells[i] ?? "").trim()));
    rows.push(row);
  }
  return rows;
}

/** `"+01273665"` → `12.73665`. Returns undefined for blank or non-numeric input. */
function coord(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n / 1e5 : undefined;
}

function lcd(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  // 0 is the format's "no location" placeholder, not a coded location.
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface LclFiles {
  /** `POINTS.DAT` — coded points and their coordinates. */
  points: string;
  /** `POFFSETS.DAT` — each point's neighbours along its road. */
  poffsets?: string;
  /** `LOCATIONDATASETS.DAT` — declares the table's CID/TABCD/VERSION. */
  locationDatasets: string;
  /** `COUNTRIES.DAT` — maps the CID to its alphabetic codes. */
  countries?: string;
  /** `ROADS.DAT` — road numbers a point may belong to. */
  roads?: string;
  /** `SEGMENTS.DAT` — carries a road number for points linked by segment. */
  segments?: string;
}

/**
 * Build a table from the exchange-format files.
 *
 * Points with no coordinates are dropped: they cannot place an event, and
 * keeping them would let the resolver report a confident hit that resolves to
 * nothing.
 */
export function buildTmcTable(
  files: LclFiles,
  meta: { attribution: string; license: string }
): TmcLocationTable {
  const dataset = parseDatFile(files.locationDatasets)[0];
  if (!dataset) throw new Error("LOCATIONDATASETS.DAT is empty — cannot determine table version");
  const cid = Number.parseInt(dataset["CID"] ?? "", 10);
  const tabcd = Number.parseInt(dataset["TABCD"] ?? "", 10);
  const version = dataset["VERSION"]?.trim();
  if (!Number.isFinite(cid) || !Number.isFinite(tabcd) || !version) {
    throw new Error("LOCATIONDATASETS.DAT is missing CID, TABCD or VERSION");
  }

  const country = files.countries
    ? parseDatFile(files.countries).find((r) => Number.parseInt(r["CID"] ?? "", 10) === cid)
    : undefined;

  // A point names its road directly (`ROA_LCD`) or through the segment it sits
  // on (`SEG_LCD`); both routes are followed, which covers 96% of the table.
  const roadByLcd = new Map<string, string>();
  for (const row of files.roads ? parseDatFile(files.roads) : []) {
    if (row["LCD"] && row["ROADNUMBER"]) roadByLcd.set(row["LCD"], row["ROADNUMBER"]);
  }
  const segmentRoad = new Map<string, string>();
  for (const row of files.segments ? parseDatFile(files.segments) : []) {
    const road = row["ROADNUMBER"] || roadByLcd.get(row["ROA_LCD"] ?? "") || "";
    if (row["LCD"] && road) segmentRoad.set(row["LCD"], road);
  }

  const points = new Map<number, TmcPoint>();
  for (const row of parseDatFile(files.points)) {
    const code = lcd(row["LCD"]);
    const lon = coord(row["XCOORD"]);
    const lat = coord(row["YCOORD"]);
    if (code === undefined || lon === undefined || lat === undefined) continue;
    const road = roadByLcd.get(row["ROA_LCD"] ?? "") ?? segmentRoad.get(row["SEG_LCD"] ?? "");
    points.set(code, { lon, lat, ...(road ? { road } : {}) });
  }

  for (const row of files.poffsets ? parseDatFile(files.poffsets) : []) {
    const code = lcd(row["LCD"]);
    const point = code === undefined ? undefined : points.get(code);
    if (!point) continue;
    const pos = lcd(row["POS_OFF_LCD"]);
    const neg = lcd(row["NEG_OFF_LCD"]);
    if (pos !== undefined) point.pos = pos;
    if (neg !== undefined) point.neg = neg;
  }

  return {
    cid,
    tabcd,
    version,
    ...(country?.["CCD"] ? { ccd: country["CCD"] } : {}),
    ...(country?.["ECC"] ? { ecc: country["ECC"] } : {}),
    attribution: meta.attribution,
    license: meta.license,
    points,
  };
}

export function toSnapshot(table: TmcLocationTable): TmcTableSnapshot {
  const points = [...table.points.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([code, p]) =>
        [code, p.lon, p.lat, p.pos ?? 0, p.neg ?? 0, p.road ?? ""] as [
          number,
          number,
          number,
          number,
          number,
          string,
        ]
    );
  return {
    cid: table.cid,
    tabcd: table.tabcd,
    version: table.version,
    ...(table.ccd ? { ccd: table.ccd } : {}),
    ...(table.ecc ? { ecc: table.ecc } : {}),
    attribution: table.attribution ?? "",
    license: table.license ?? "",
    points,
  };
}

export function fromSnapshot(snap: TmcTableSnapshot): TmcLocationTable {
  const points = new Map<number, TmcPoint>();
  for (const [code, lon, lat, pos, neg, road] of snap.points) {
    points.set(code, {
      lon,
      lat,
      ...(pos ? { pos } : {}),
      ...(neg ? { neg } : {}),
      ...(road ? { road } : {}),
    });
  }
  return {
    cid: snap.cid,
    tabcd: snap.tabcd,
    version: snap.version,
    ...(snap.ccd ? { ccd: snap.ccd } : {}),
    ...(snap.ecc ? { ecc: snap.ecc } : {}),
    attribution: snap.attribution,
    license: snap.license,
    points,
  };
}
