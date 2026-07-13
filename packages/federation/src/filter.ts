/**
 * The v1 subscriber filter, applied AT SOURCE to every outbox page before it
 * leaves the instance (the plan's full compositional and/or/not language is a
 * later protocol version). Filtered-out entries simply leave gaps in the seq
 * stream — the page's highWaterMark still advances over them.
 *
 * The DEFAULT (no filter, e.g. a Tier-0 public fetch) is the safe one:
 * corroborated-or-better evidence plus permissive-only licensing. That means
 * self_reported crowd rows (routingEligible=false projections) and share-alike
 * licensed rows require an EXPLICIT opt-in via `minEvidenceTier:
 * "self_reported"` / `permissiveOnly: false` respectively.
 *
 * Delete tombstones always pass: a retraction must reach every subscriber that
 * might still hold the object, and it carries no content to filter on.
 */
import type { Geometry, Position } from "geojson";
import { filterForPermissiveExport } from "@openconditions/publishers";
import type { OutboxEntry } from "./outbox.js";

export interface FederationFilter {
  /** [west, south, east, north]; kept when the geometry's bbox intersects. */
  bbox?: [number, number, number, number];
  /** Event `type` allow-list (a measurement row has no type and is dropped). */
  types?: string[];
  /** `privacyClass` allow-list. */
  privacyClasses?: string[];
  /** Drop share-alike-licensed rows (DEFAULT true — explicit opt-out). */
  permissiveOnly?: boolean;
  /** Minimum crowd evidence tier (DEFAULT "corroborated" — explicit opt-in
   *  for self_reported). Feed rows are authoritative and never gated by it. */
  minEvidenceTier?: string;
  /** Drop entries whose dataUpdatedAt is older than this many seconds. */
  maxAgeSec?: number;
}

/** The evidence tiers a subscriber can ask for, weakest first. */
export const EVIDENCE_TIERS = ["self_reported", "corroborated", "externally_resolved"] as const;

export const DEFAULT_MIN_EVIDENCE_TIER = "corroborated";

const TIER_RANK: Record<string, number> = Object.fromEntries(
  EVIDENCE_TIERS.map((tier, rank) => [tier, rank])
);

function bboxOfPositions(positions: Position[], acc: number[]): void {
  for (const [x, y] of positions) {
    if (x! < acc[0]!) acc[0] = x!;
    if (y! < acc[1]!) acc[1] = y!;
    if (x! > acc[2]!) acc[2] = x!;
    if (y! > acc[3]!) acc[3] = y!;
  }
}

function collectBbox(geometry: Geometry, acc: number[]): void {
  switch (geometry.type) {
    case "Point":
      bboxOfPositions([geometry.coordinates], acc);
      break;
    case "MultiPoint":
    case "LineString":
      bboxOfPositions(geometry.coordinates, acc);
      break;
    case "MultiLineString":
    case "Polygon":
      for (const ring of geometry.coordinates) bboxOfPositions(ring, acc);
      break;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) bboxOfPositions(ring, acc);
      }
      break;
    case "GeometryCollection":
      for (const member of geometry.geometries) collectBbox(member, acc);
      break;
  }
}

/** Bounding-box intersection test (v1: bbox-vs-bbox, not exact geometry). */
function intersectsBbox(geometry: Geometry, bbox: [number, number, number, number]): boolean {
  const acc = [Infinity, Infinity, -Infinity, -Infinity];
  collectBbox(geometry, acc);
  const [minX, minY, maxX, maxY] = acc;
  if (minX === Infinity) return false;
  const [west, south, east, north] = bbox;
  return maxX! >= west && minX! <= east && maxY! >= south && minY! <= north;
}

/**
 * Applies the subscriber's filter to a scanned page of outbox entries.
 * `now` is the evaluation instant (ISO 8601) for `maxAgeSec`. Under
 * `permissiveOnly` the surviving observations are the
 * {@link filterForPermissiveExport} projections (reporter-stripped — a
 * belt-and-suspenders re-strip; snapshots rest reporter-free already — and
 * share-alike merged-source traces removed).
 */
export function applyFederationFilter(
  entries: OutboxEntry[],
  filter: FederationFilter | undefined,
  now: string
): OutboxEntry[] {
  const permissiveOnly = filter?.permissiveOnly ?? true;
  const minTier = filter?.minEvidenceTier ?? DEFAULT_MIN_EVIDENCE_TIER;
  const minRank = TIER_RANK[minTier] ?? TIER_RANK[DEFAULT_MIN_EVIDENCE_TIER]!;
  const nowMs = Date.parse(now);

  const out: OutboxEntry[] = [];
  for (const entry of entries) {
    if (entry.operation === "delete" || entry.observation === undefined) {
      out.push(entry);
      continue;
    }
    const observation = entry.observation;

    if (observation.origin.kind === "crowd") {
      const rank = TIER_RANK[observation.evidenceState ?? ""];
      if (rank === undefined || rank < minRank) continue;
    }

    if (filter?.maxAgeSec !== undefined) {
      const updatedMs = Date.parse(observation.dataUpdatedAt);
      if (!Number.isFinite(updatedMs) || nowMs - updatedMs > filter.maxAgeSec * 1000) continue;
    }

    if (filter?.bbox !== undefined && !intersectsBbox(observation.geometry, filter.bbox)) {
      continue;
    }

    if (filter?.types !== undefined) {
      const type = (observation as { type?: string }).type;
      if (type === undefined || !filter.types.includes(type)) continue;
    }

    if (filter?.privacyClasses !== undefined) {
      const privacyClass = observation.privacyClass ?? "unknown";
      if (!filter.privacyClasses.includes(privacyClass)) continue;
    }

    if (permissiveOnly) {
      const [exported] = filterForPermissiveExport([observation]);
      if (exported === undefined) continue;
      out.push({ ...entry, observation: exported });
      continue;
    }

    out.push(entry);
  }
  return out;
}
