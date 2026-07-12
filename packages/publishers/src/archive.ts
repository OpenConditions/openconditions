import type { GeoJsonGeometry, Observation, PrivacyClass } from "@openconditions/core";
import type { ColumnSource } from "hyparquet-writer";
import { geojsonToWkb, parquetWriteBuffer } from "hyparquet-writer";
import { filterForPermissiveExport } from "./license.js";

/**
 * One flat row of the redistributable static archive — the published view of a
 * single observation, stripped down to the columns that are safe to mirror.
 *
 * Deliberately NOT present: `origin.reporter` (the crowd keyId/signature/
 * reputation), the `report_evidence` ledger, and `sourceRaw`. A crowd
 * observation's identity never travels; only its `privacyClass`, `originKind`
 * ("crowd"), and public attribution do. `geometry` is kept as GeoJSON here so
 * the projection stays pure and testable; {@link dailyGeoParquet} encodes it to
 * WKB for the GeoParquet file.
 */
export interface ArchiveRow {
  id: string;
  source: string;
  domain: string;
  kind: Observation["kind"];
  /** Event `type` (null on measurements). */
  type: string | null;
  /** Measurement `metric` (null on events). */
  metric: string | null;
  /** Event `severity` (null on measurements). */
  severity: string | null;
  /** Event `headline` (null on measurements). */
  headline: string | null;
  geometry: GeoJsonGeometry;
  validFrom: string | null;
  validTo: string | null;
  dataUpdatedAt: string;
  confidenceScore: number | null;
  privacyClass: string | null;
  evidenceState: string | null;
  fuzziness: string | null;
  sourceLicense: string | null;
  instanceId: string | null;
  /** "feed" | "crowd" — the surviving `origin.kind`, never the reporter block. */
  originKind: string;
  attributionProvider: string;
  attributionLicense: string;
  attributionUrl: string | null;
}

/**
 * The privacy tiers whose rows are released/published and therefore mirrorable.
 * A row in any other state — notably a future probe / dp-staging marker — is NOT
 * released and must never enter the archive; {@link isPublishablePrivacy} drops
 * it by construction (fail-closed).
 */
const RELEASED_PRIVACY_CLASSES: ReadonlySet<PrivacyClass> = new Set<PrivacyClass>([
  "authoritative",
  "aggregate",
  "crowd_pseudonym",
  "dp_noised",
  "k_anon",
]);

function isPublishablePrivacy(o: Observation): boolean {
  const pc = o.privacyClass;
  // Fail-closed: an explicitly released tier is publishable. A missing/legacy
  // class (undefined or the "unknown" DB sentinel, not part of the enum) is only
  // publishable for FEED rows — those are authoritative published data. A
  // crowd/probe row that somehow arrives without a class is excluded rather than
  // assumed safe, so an unreleased row can never slip through on a null default.
  if (pc == null || (pc as string) === "unknown") return o.origin.kind === "feed";
  return RELEASED_PRIVACY_CLASSES.has(pc);
}

function toRow(o: Observation): ArchiveRow {
  const att = o.origin.attribution;
  const asEvent = o as Observation & { type?: string; severity?: string; headline?: string };
  const asMeasurement = o as Observation & { metric?: string };
  return {
    id: o.id,
    source: o.source,
    domain: o.domain,
    kind: o.kind,
    type: o.kind === "event" ? (asEvent.type ?? null) : null,
    metric: o.kind === "measurement" ? (asMeasurement.metric ?? null) : null,
    severity: o.kind === "event" ? (asEvent.severity ?? null) : null,
    headline: o.kind === "event" ? (asEvent.headline ?? null) : null,
    geometry: o.geometry,
    validFrom: o.validFrom ?? null,
    validTo: o.validTo ?? null,
    dataUpdatedAt: o.dataUpdatedAt,
    confidenceScore: o.confidenceScore ?? null,
    privacyClass: o.privacyClass ?? null,
    evidenceState: o.evidenceState ?? null,
    fuzziness: o.fuzziness ?? null,
    sourceLicense: o.sourceLicense ?? null,
    instanceId: o.instanceId ?? null,
    // Only `origin.kind` survives — `origin.reporter` (keyId/signature/
    // reputation) is never read here. `filterForPermissiveExport` already
    // stripped it upstream for every public projection; this flattening is
    // defense-in-depth so crowd identity cannot enter a mirrorable artifact.
    originKind: o.origin.kind,
    attributionProvider: att.provider,
    attributionLicense: att.license,
    attributionUrl: att.url ?? null,
  };
}

/**
 * Projects observations to the archive's published view — the ONLY rows that may
 * be mirrored. Enforces, in order:
 *  1. License + identity: `filterForPermissiveExport` drops any share-alike
 *     record and strips `origin.reporter` from every survivor (the archive is a
 *     permissive, de-identified redistributable bundle).
 *  2. Status allowlist: only `status === "active"` passes — archived tombstones,
 *     cancelled rows, and any unknown status are dropped (fail-closed).
 *  3. Expiry / validity: a row past its `expiresAt` or `validTo` (relative to
 *     `now`) is dropped, so a stale artifact never republishes dead conditions.
 *  4. Privacy: only released tiers pass; a missing class is trusted only for feed
 *     rows, so raw crowd evidence and probe staging never enter (see
 *     {@link isPublishablePrivacy}).
 * Finally each surviving row is flattened. Pure: `now` is an explicit ISO instant
 * so the projection is deterministic.
 */
export function toPublishedArchiveRows(obs: Observation[], now: string): ArchiveRow[] {
  const permissive = filterForPermissiveExport(obs);
  const rows: ArchiveRow[] = [];
  for (const o of permissive) {
    // Status allowlist (fail-closed): only an explicitly active row is
    // publishable. This drops archived tombstones and cancelled rows, and also
    // any future/unknown status rather than assuming it is safe to mirror.
    if (o.status !== "active") continue;
    if (o.expiresAt != null && o.expiresAt <= now) continue;
    if (o.validTo != null && o.validTo <= now) continue;
    if (!isPublishablePrivacy(o)) continue;
    rows.push(toRow(o));
  }
  return rows;
}

/** GeoParquet 1.0 "geo" file-metadata value for a WKB geometry column in CRS84. */
function geoMetadata(rows: ArchiveRow[]): Record<string, unknown> {
  const geometryTypes = [...new Set(rows.map((r) => r.geometry.type))];
  return {
    version: "1.0.0",
    primary_column: "geometry",
    columns: {
      geometry: {
        encoding: "WKB",
        // GeoParquet allows an empty array to mean "any/unknown"; on an empty
        // archive there are no geometries to enumerate.
        geometry_types: geometryTypes,
        // `crs` omitted → GeoParquet default OGC:CRS84 (lon/lat, WGS84), which
        // is exactly what our GeoJSON coordinates already are.
      },
    },
  };
}

type ColumnSpec = {
  name: string;
  type: ColumnSource["type"];
  nullable?: boolean;
  get: (r: ArchiveRow) => unknown;
};

// Explicit per-column types so the schema is well-defined even for an empty
// archive (auto-inference cannot type an all-null or empty column). The geometry
// column is a plain BYTE_ARRAY of ISO WKB (GeoParquet WKB encoding), NOT the
// Parquet-native GEOMETRY logical type, so any GeoParquet 1.0 reader works.
const COLUMN_SPECS: ColumnSpec[] = [
  { name: "id", type: "STRING", get: (r) => r.id },
  { name: "source", type: "STRING", get: (r) => r.source },
  { name: "domain", type: "STRING", get: (r) => r.domain },
  { name: "kind", type: "STRING", get: (r) => r.kind },
  { name: "type", type: "STRING", nullable: true, get: (r) => r.type },
  { name: "metric", type: "STRING", nullable: true, get: (r) => r.metric },
  { name: "severity", type: "STRING", nullable: true, get: (r) => r.severity },
  { name: "headline", type: "STRING", nullable: true, get: (r) => r.headline },
  { name: "validFrom", type: "STRING", nullable: true, get: (r) => r.validFrom },
  { name: "validTo", type: "STRING", nullable: true, get: (r) => r.validTo },
  { name: "dataUpdatedAt", type: "STRING", get: (r) => r.dataUpdatedAt },
  { name: "confidenceScore", type: "DOUBLE", nullable: true, get: (r) => r.confidenceScore },
  { name: "privacyClass", type: "STRING", nullable: true, get: (r) => r.privacyClass },
  { name: "evidenceState", type: "STRING", nullable: true, get: (r) => r.evidenceState },
  { name: "fuzziness", type: "STRING", nullable: true, get: (r) => r.fuzziness },
  { name: "sourceLicense", type: "STRING", nullable: true, get: (r) => r.sourceLicense },
  { name: "instanceId", type: "STRING", nullable: true, get: (r) => r.instanceId },
  { name: "originKind", type: "STRING", get: (r) => r.originKind },
  { name: "attributionProvider", type: "STRING", get: (r) => r.attributionProvider },
  { name: "attributionLicense", type: "STRING", get: (r) => r.attributionLicense },
  { name: "attributionUrl", type: "STRING", nullable: true, get: (r) => r.attributionUrl },
  { name: "geometry", type: "BYTE_ARRAY", get: (r) => geojsonToWkb(r.geometry) },
];

/**
 * Serializes the published archive view of `obs` to a GeoParquet buffer.
 *
 * Format: Parquet with the geometry stored as ISO WKB in a BYTE_ARRAY column and
 * the GeoParquet 1.0 `geo` key in the file's key-value metadata (primary_column
 * "geometry", encoding "WKB", CRS84). Read it back with any Parquet reader; a
 * GeoParquet-aware reader (or `hyparquet` with `utf8: false`) yields raw WKB.
 *
 * The published-view filter ({@link toPublishedArchiveRows}) runs here, so the
 * buffer can NEVER contain an expired, tombstoned, share-alike, probe-staging,
 * or reporter-identity-bearing row regardless of what the caller passes in.
 */
export async function dailyGeoParquet(obs: Observation[], now: string): Promise<Uint8Array> {
  const rows = toPublishedArchiveRows(obs, now);
  const columnData: ColumnSource[] = COLUMN_SPECS.map((spec) => ({
    name: spec.name,
    type: spec.type,
    nullable: spec.nullable ?? false,
    data: rows.map(spec.get),
  }));
  const buffer = parquetWriteBuffer({
    columnData,
    kvMetadata: [{ key: "geo", value: JSON.stringify(geoMetadata(rows)) }],
  });
  return new Uint8Array(buffer);
}
