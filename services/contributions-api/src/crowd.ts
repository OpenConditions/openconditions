import { licenseInfo } from "@openconditions/ingest-framework";
import type { AgreeingSituation, EvidenceState, Validity } from "@openconditions/model";
import type postgres from "postgres";

type Db = postgres.Sql | postgres.TransactionSql;

/** The source id every crowd record carries, local or a peer's. */
export const CROWD_SOURCE_ID = "crowd";

/**
 * The licence this instance's crowd reports are published under:
 * `OPENCONDITIONS_CROWD_LICENSE`, ODbL by default. Throws on an id the licence
 * registry does not know (lookup is exact, case included), so a misspelt
 * licence fails the boot instead of reaching egress as an unknown one.
 */
export function resolveCrowdLicense(env: Record<string, string | undefined>): string {
  const license = env["OPENCONDITIONS_CROWD_LICENSE"] || "ODbL-1.0";
  if (!licenseInfo(license)) {
    throw new Error(
      `OPENCONDITIONS_CROWD_LICENSE "${license}" is not a known licence id: use an SPDX id or LicenseRef-<name> from the licence registry, matching case exactly (e.g. ODbL-1.0)`,
    );
  }
  return license;
}

/**
 * Takes the crowd source's advisory lock, as every write to a source's
 * records does (the poll, the sweep and the writer alike): crowd landings,
 * votes, merges and resolutions never interleave.
 */
export async function lockCrowd(tx: postgres.TransactionSql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${CROWD_SOURCE_ID}))`;
}

/** Who stands behind a stored situation, as agreement and reputation read it. */
export interface Actor {
  origin: string;
  sourceId: string;
  /** The reporter's key: on a local crowd report only (peers strip it). */
  keyId?: string;
  /** Hops the record took to get here; empty for this instance's own records. */
  originChain: readonly unknown[];
}

/** A stored situation as the crowd paths read it. */
export interface StoredSituation {
  id: string;
  kind: string;
  type: string;
  record: Record<string, unknown>;
  evidenceState: EvidenceState | null;
  routingEligible: boolean;
  flaggedAt: Date | null;
  tombstoneReason: string | null;
}

const COLUMNS = [
  "id",
  "kind",
  "type",
  "record",
  "evidence_state",
  "routing_eligible",
  "flagged_at",
  "tombstone_reason",
];
const columns = (alias: string) => COLUMNS.map((c) => `${alias}.${c}`).join(", ");

interface Row {
  id: string;
  kind: string;
  type: string;
  record: Record<string, unknown>;
  evidence_state: EvidenceState | null;
  routing_eligible: boolean;
  flagged_at: Date | null;
  tombstone_reason: string | null;
}

function toSituation(row: Row): StoredSituation {
  return {
    id: row.id,
    kind: row.kind,
    type: row.type,
    record: row.record,
    evidenceState: row.evidence_state,
    routingEligible: row.routing_eligible,
    flaggedAt: row.flagged_at,
    tombstoneReason: row.tombstone_reason,
  };
}

/** One stored situation, locked for the caller's transaction when asked. */
export async function loadSituation(
  db: Db,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<StoredSituation | undefined> {
  const rows = await db.unsafe<Row[]>(
    `SELECT ${columns("s")} FROM conditions.situation s
      WHERE s.id = $1${opts.forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] === undefined ? undefined : toSituation(rows[0]);
}

/** Stored situations by id. */
export async function loadSituations(db: Db, ids: readonly string[]): Promise<StoredSituation[]> {
  if (ids.length === 0) return [];
  const rows = await db.unsafe<Row[]>(
    `SELECT ${columns("s")} FROM conditions.situation s WHERE s.id = ANY($1::text[])`,
    [ids as string[]],
  );
  return rows.map(toSituation);
}

/**
 * The live situations of a kind and type within `metres` of a geometry, the
 * candidates agreement then decides on (`situationsAgree`). Superseded
 * reports (merged into a survivor) are included when asked, so a new report
 * near one finds its survivor.
 */
export async function nearbySituations(
  db: Db,
  target: StoredSituation,
  metres: number,
  opts: { origins: readonly string[]; includeSuperseded?: boolean },
): Promise<StoredSituation[]> {
  const geometry = (target.record["location"] as { geometry: unknown } | undefined)?.geometry;
  if (geometry === null || geometry === undefined) return [];
  const live = opts.includeSuperseded
    ? "(s.tombstoned_at IS NULL OR s.tombstone_reason = 'superseded')"
    : "s.tombstoned_at IS NULL";
  const rows = await db.unsafe<Row[]>(
    `SELECT ${columns("s")}
       FROM conditions.situation s
      WHERE s.kind = $1 AND s.type = $2 AND s.id <> $3
        AND s.origin = ANY($4::text[])
        AND ${live}
        AND ST_DWithin(s.geom::geography, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)::geography, $6)`,
    [
      target.kind,
      target.type,
      target.id,
      opts.origins as string[],
      JSON.stringify(geometry),
      metres,
    ],
  );
  return rows.map(toSituation);
}

/** Who stands behind a stored situation. */
export function actorOf(record: Record<string, unknown>): Actor {
  const provenance = (record["provenance"] ?? {}) as {
    origin?: string;
    sourceId?: string;
    reporter?: { keyId?: string };
    originChain?: unknown[];
  };
  return {
    origin: provenance.origin ?? "feed",
    sourceId: provenance.sourceId ?? "",
    ...(provenance.reporter?.keyId === undefined ? {} : { keyId: provenance.reporter.keyId }),
    originChain: provenance.originChain ?? [],
  };
}

/** The parts of a stored situation agreement reads. */
export function agreeing(situation: StoredSituation): AgreeingSituation {
  const record = situation.record as {
    location: { geometry: unknown };
    validity: Validity;
  };
  return {
    kind: situation.kind,
    type: situation.type,
    location: record.location,
    validity: record.validity,
  };
}
