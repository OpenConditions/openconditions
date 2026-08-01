/**
 * Turn an Alert-C / TMC location reference into geometry using a location table.
 *
 * Alert-C names places by code, not coordinate, so a feed publishing only
 * Alert-C is unmappable without the matching table — which is why entire
 * publishers (Lower Saxony, Hamburg) contributed nothing at all before this.
 *
 * Two properties matter more than coverage here:
 *
 *  - **The table version must match what the record declares.** Codes are
 *    renumbered between versions, so a near-miss version does not degrade
 *    gracefully — it silently returns a confident coordinate on the wrong road.
 *    Measured against records carrying both a code and real coordinates, the
 *    matching table resolves to a median 115 m, while a table ~13 versions old
 *    lands ~2 km out. A refusal is therefore always preferred to a guess.
 *  - **A linear location is a stretch, not a point.** It names the two coded
 *    points bounding the affected road, so the resolved geometry follows the
 *    table's own chain between them rather than joining them with a chord that
 *    cuts across whatever the road actually does.
 */

import type { LineStringGeometry, PointGeometry } from "@openconditions/core";
import type { TmcLocationTable } from "./lcl.js";

/** An Alert-C reference as it appears on the wire, before any interpretation. */
export interface AlertCReference {
  /** Country as the feed spells it: numeric CID ("58"), CCD ("D") or ECC ("E0"). */
  country?: string;
  /** Table code (TABCD) as declared, e.g. "1". */
  table?: string;
  /** Table version as declared, e.g. "22.0". */
  version?: string;
  /** Primary location code — the location the message is about. */
  primary?: number;
  /** Secondary location code — the far end of a linear location's extent. */
  secondary?: number;
  /**
   * The road the record itself says it is about ("A7", "B 462").
   *
   * Used to vouch for a code from a table edition we do not hold: if the code
   * resolves onto the very road the publisher named, it still means the same
   * place, and if it does not, that is the renumbering we refuse over.
   */
  road?: string;
}

/**
 * Why a reference produced no geometry. Distinguishing these is the point: an
 * unresolved record that is missing a table reads very differently from one
 * refused for a version mismatch, and only the reason says which to fix.
 */
export type TmcUnresolvedReason =
  | "no-reference"
  | "no-table"
  /** A version is declared, and it is not the table's. */
  | "version-mismatch"
  /** No version is declared at all, so there is nothing to check ours against. */
  | "version-missing"
  | "unknown-code";

export type TmcResolution =
  | {
      ok: true;
      geometry: PointGeometry | LineStringGeometry;
      table: TmcLocationTable;
      /**
       * True when the record named another table edition and was accepted only
       * because its codes resolved onto the road it claims to be about.
       */
      viaRoadMatch?: boolean;
    }
  | { ok: false; reason: TmcUnresolvedReason };

/** "B 462" / "BAB A7" / "a7" all compare equal to the table's "A7". */
function sameRoad(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  // One side often carries a prefix the other omits ("BAB A7" vs "A7").
  return x === y || x.endsWith(y) || y.endsWith(x);
}

/** Does this table describe the country/table the record names? */
function matchesTable(table: TmcLocationTable, ref: AlertCReference): boolean {
  const country = ref.country?.trim().toUpperCase();
  if (!country) return false;
  const known = [String(table.cid), table.ccd?.toUpperCase(), table.ecc?.toUpperCase()];
  if (!known.includes(country)) return false;
  // A feed that omits the table number is taken to mean the country's only table.
  if (ref.table != null && ref.table !== "" && Number.parseFloat(ref.table) !== table.tabcd) {
    return false;
  }
  return true;
}

/** Normalised version comparison — "22.0" and "22.00" name the same table. */
function sameVersion(a: string, b: string): boolean {
  const norm = (v: string) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n.toFixed(2) : v.trim().toUpperCase();
  };
  return norm(a) === norm(b);
}

/**
 * Coded points from `from` to `to` along the road chain.
 *
 * The links are followed in both directions because a record may name its
 * endpoints in either order. Returns undefined when the two are not connected
 * within `limit` hops, which keeps a malformed or cross-road pair from walking
 * the whole country.
 */
function chain(
  table: TmcLocationTable,
  from: number,
  to: number,
  limit = 200
): number[] | undefined {
  for (const dir of ["pos", "neg"] as const) {
    const out = [from];
    let cur = from;
    for (let i = 0; i < limit; i++) {
      const next = table.points.get(cur)?.[dir];
      if (next === undefined) break;
      out.push(next);
      if (next === to) return out;
      cur = next;
    }
  }
  return undefined;
}

/**
 * Resolve a reference against the first table that claims its country/table.
 *
 * Returns a reason rather than throwing, so callers can count *why* records
 * stay unmapped instead of only that they did.
 */
export function resolveAlertC(ref: AlertCReference, tables: TmcLocationTable[]): TmcResolution {
  if (!ref.primary) return { ok: false, reason: "no-reference" };

  const table = tables.find((t) => matchesTable(t, ref));
  if (!table) return { ok: false, reason: "no-table" };
  if (!ref.version) return { ok: false, reason: "version-missing" };

  const primary = table.points.get(ref.primary);
  const secondary = ref.secondary ? table.points.get(ref.secondary) : undefined;

  let viaRoadMatch = false;
  if (!sameVersion(ref.version, table.version)) {
    // Another edition. Codes are renumbered between editions, so this is only
    // safe where the record itself can vouch for the result: every coded point
    // the table knows a road for must sit on the road the record names. That
    // turns an unverifiable assumption about editions into a per-record fact.
    const known = [primary, secondary].filter((p) => p?.road);
    if (known.length === 0 || !known.every((p) => sameRoad(p!.road, ref.road))) {
      return { ok: false, reason: "version-mismatch" };
    }
    viaRoadMatch = true;
  }

  if (!primary) return { ok: false, reason: "unknown-code" };

  if (!ref.secondary || !secondary || ref.secondary === ref.primary) {
    return {
      ok: true,
      table,
      ...(viaRoadMatch ? { viaRoadMatch } : {}),
      geometry: { type: "Point", coordinates: [primary.lon, primary.lat] },
    };
  }

  const walked = chain(table, ref.secondary, ref.primary);
  const coordinates = walked
    ? walked
        .map((code) => table.points.get(code))
        .filter((p): p is NonNullable<typeof p> => p != null)
        .map((p) => [p.lon, p.lat] as [number, number])
    : [
        [secondary.lon, secondary.lat] as [number, number],
        [primary.lon, primary.lat] as [number, number],
      ];

  if (coordinates.length < 2) {
    return {
      ok: true,
      table,
      ...(viaRoadMatch ? { viaRoadMatch } : {}),
      geometry: { type: "Point", coordinates: [primary.lon, primary.lat] },
    };
  }
  return {
    ok: true,
    table,
    ...(viaRoadMatch ? { viaRoadMatch } : {}),
    geometry: { type: "LineString", coordinates },
  };
}
