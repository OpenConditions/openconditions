import { federationEligible, type RecordClass, subjectKey } from "@openconditions/model";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { ColumnSource, Writer } from "hyparquet-writer";
import { geojsonToWkb, parquetWriteBuffer, parquetWriteRows } from "hyparquet-writer";
import { type EgressRecord, permissiveRecords } from "./license.js";

/** The parts of a stored model record the archive reads. */
export interface ArchivableRecord extends EgressRecord {
  id: string;
  class: RecordClass;
  kind: string;
  type?: string;
  subtype?: string;
  domain: string;
  temporality: string;
  canonicalId: string;
  revision: number;
  recordedAt: string;
  location: { geometry: unknown };
  provenance: EgressRecord["provenance"] & {
    origin: string;
    sourceId: string;
    accessMode: string;
    attribution: { provider: string; license: string; url?: string };
    privacy: { class: string };
  };
  freshness: { expiresAt?: string };
  tombstone?: unknown;
  evidence?: { state: string };
  [field: string]: unknown;
}

const LIVE_EVIDENCE = new Set(["corroborated", "externally_resolved"]);
const ENDED = new Set(["ended", "cancelled"]);

const after = (instant: unknown, now: string) =>
  instant === undefined || (typeof instant === "string" && Date.parse(instant) > Date.parse(now));

/** Whether a record is still what its class says is current: in effect, operating, unexpired. */
function current(r: ArchivableRecord, now: string): boolean {
  const validity = r["validity"] as { status: string; end?: string } | undefined;
  switch (r.class) {
    case "situation":
      return validity !== undefined && !ENDED.has(validity.status) && after(validity.end, now);
    case "offer":
      return validity !== undefined && after(validity.end, now);
    case "observation":
      return after(r["validUntil"], now);
    case "feature":
      return r["lifecycle"] !== "decommissioned";
  }
}

export interface ArchiveOptions {
  /** Whether a source opted in to sharing its allow-listed extras (the source registry's `extrasFederate`). */
  federateExtras?: (sourceId: string) => boolean;
}

/**
 * The records the archive may mirror, in one class: records a peer could
 * receive (no on-demand answers, no fused rows), not tombstoned, current for
 * their class, and — for crowd records — corroborated or better and not yet
 * decayed, as the federation's default filter asks. Then the permissive
 * projection: share-alike records out, reporters stripped, and a source's
 * allow-listed extras withheld unless `federateExtras` says the source shares
 * them, as for a peer. Pure: `now` is an input.
 */
export function publishedRecords<T extends ArchivableRecord>(
  cls: RecordClass,
  records: readonly T[],
  now: string,
  opts: ArchiveOptions = {},
): T[] {
  const kept = records.filter((r) => {
    if (r.class !== cls || !federationEligible(r) || r.tombstone !== undefined) return false;
    const crowd =
      r.provenance.origin === "crowd" || r.provenance.privacy.class === "crowd_pseudonym";
    if (
      crowd &&
      (!LIVE_EVIDENCE.has(r.evidence?.state ?? "") || !after(r.freshness.expiresAt, now))
    )
      return false;
    return current(r, now);
  });
  return permissiveRecords(kept).map((r) => {
    if (r["extras"] === undefined || opts.federateExtras?.(r.provenance.sourceId)) return r;
    const { extras: _extras, ...rest } = r;
    return rest as T;
  });
}

type Column = {
  name: string;
  type: ColumnSource["type"];
  nullable?: boolean;
  get: (r: ArchivableRecord) => unknown;
};

const text = (value: unknown) =>
  Array.isArray(value) ? ((value[0] as { text?: string } | undefined)?.text ?? null) : null;
const iso = (value: unknown) => (typeof value === "string" ? value : null);

const COMMON: Column[] = [
  { name: "id", type: "STRING", get: (r) => r.id },
  { name: "canonical_id", type: "STRING", get: (r) => r.canonicalId },
  { name: "kind", type: "STRING", get: (r) => r.kind },
  { name: "type", type: "STRING", nullable: true, get: (r) => r.type ?? null },
  { name: "subtype", type: "STRING", nullable: true, get: (r) => r.subtype ?? null },
  { name: "domain", type: "STRING", get: (r) => r.domain },
  { name: "temporality", type: "STRING", get: (r) => r.temporality },
  { name: "source_id", type: "STRING", get: (r) => r.provenance.sourceId },
  { name: "origin", type: "STRING", get: (r) => r.provenance.origin },
  { name: "privacy_class", type: "STRING", get: (r) => r.provenance.privacy.class },
  { name: "evidence_state", type: "STRING", nullable: true, get: (r) => r.evidence?.state ?? null },
  { name: "attribution_provider", type: "STRING", get: (r) => r.provenance.attribution.provider },
  { name: "attribution_license", type: "STRING", get: (r) => r.provenance.attribution.license },
  {
    name: "attribution_url",
    type: "STRING",
    nullable: true,
    get: (r) => r.provenance.attribution.url ?? null,
  },
  { name: "revision", type: "INT32", get: (r) => r.revision },
  { name: "recorded_at", type: "STRING", get: (r) => r.recordedAt },
];

const validityColumns: Column[] = [
  {
    name: "valid_from",
    type: "STRING",
    nullable: true,
    get: (r) => iso((r["validity"] as { start?: string }).start),
  },
  {
    name: "valid_to",
    type: "STRING",
    nullable: true,
    get: (r) => iso((r["validity"] as { end?: string }).end),
  },
];

const resultOf = (r: ArchivableRecord) => r["result"] as Record<string, unknown>;
const phenomenon = (r: ArchivableRecord) =>
  r["phenomenonTime"] as { instant?: string; start?: string; end?: string };

/** The promoted columns of each class; the whole record rides along as JSON. */
const CLASS_COLUMNS: Record<RecordClass, Column[]> = {
  situation: [
    { name: "severity", type: "STRING", get: (r) => (r["severity"] as { label: string }).label },
    { name: "certainty", type: "STRING", get: (r) => r["certainty"] as string },
    {
      name: "validity_status",
      type: "STRING",
      get: (r) => (r["validity"] as { status: string }).status,
    },
    ...validityColumns,
    { name: "headline", type: "STRING", nullable: true, get: (r) => text(r["headline"]) },
  ],
  feature: [
    { name: "lifecycle", type: "STRING", get: (r) => r["lifecycle"] as string },
    { name: "name", type: "STRING", nullable: true, get: (r) => text(r["name"]) },
  ],
  observation: [
    { name: "property", type: "STRING", get: (r) => r["property"] as string },
    { name: "subject_key", type: "STRING", get: (r) => subjectKey(r as never) },
    { name: "result_type", type: "STRING", get: (r) => resultOf(r)["type"] as string },
    {
      name: "value_num",
      type: "DOUBLE",
      nullable: true,
      get: (r) => {
        const result = resultOf(r);
        if (typeof result["value"] === "number") return result["value"];
        return result["type"] === "money" ? Number(result["amount"]) : null;
      },
    },
    {
      name: "value_text",
      type: "STRING",
      nullable: true,
      get: (r) => {
        const value = resultOf(r)["value"];
        return typeof value === "string"
          ? value
          : typeof value === "boolean"
            ? String(value)
            : null;
      },
    },
    {
      name: "unit",
      type: "STRING",
      nullable: true,
      get: (r) => (resultOf(r)["unit"] ?? resultOf(r)["per"] ?? null) as string | null,
    },
    {
      name: "currency",
      type: "STRING",
      nullable: true,
      get: (r) => (resultOf(r)["currency"] ?? null) as string | null,
    },
    {
      name: "phenomenon_start",
      type: "STRING",
      get: (r) => (phenomenon(r).instant ?? phenomenon(r).start) as string,
    },
    {
      name: "phenomenon_end",
      type: "STRING",
      nullable: true,
      get: (r) => phenomenon(r).end ?? null,
    },
  ],
  offer: [
    { name: "subject_id", type: "STRING", get: (r) => (r["subject"] as { id: string }).id },
    {
      name: "component_key",
      type: "STRING",
      nullable: true,
      get: (r) => (r["subject"] as { componentKey?: string }).componentKey ?? null,
    },
    { name: "currency", type: "STRING", get: (r) => r["currency"] as string },
    ...validityColumns,
  ],
};

const TAIL: Column[] = [
  { name: "record", type: "STRING", get: (r) => JSON.stringify(r) },
  {
    name: "geometry",
    type: "BYTE_ARRAY",
    nullable: true,
    get: (r) => (r.location.geometry === null ? null : geojsonToWkb(r.location.geometry as never)),
  },
];

/** The columns of one class's archive file. */
export function recordArchiveColumns(cls: RecordClass): readonly Column[] {
  return [...COMMON, ...CLASS_COLUMNS[cls], ...TAIL];
}

const GEO_METADATA = {
  key: "geo",
  value: JSON.stringify({
    version: "1.0.0",
    primary_column: "geometry",
    // An empty list is GeoParquet's "any type"; listing them would mean buffering the export.
    columns: { geometry: { encoding: "WKB", geometry_types: [] } },
  }),
};

/** One class's published records as a GeoParquet buffer. */
export function recordArchiveBuffer(
  cls: RecordClass,
  records: readonly ArchivableRecord[],
  now: string,
  opts: ArchiveOptions = {},
): Uint8Array {
  const rows = publishedRecords(cls, records, now, opts);
  const columns = recordArchiveColumns(cls);
  const columnData: ColumnSource[] = columns.map((c) => ({
    name: c.name,
    type: c.type,
    nullable: c.nullable ?? false,
    data: rows.map(c.get),
  }));
  return new Uint8Array(parquetWriteBuffer({ columnData, kvMetadata: [GEO_METADATA] }));
}

const ROW_GROUP_SIZE = 1000;

/** Writes rows already in a class's archive columns, one bounded row group at a time. */
async function writeArchiveRows(
  cls: RecordClass,
  rows: AsyncIterable<Record<string, unknown>>,
  writer: Writer,
): Promise<void> {
  await parquetWriteRows({
    writer,
    rows,
    columns: recordArchiveColumns(cls).map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable ?? false,
    })),
    rowGroupSize: ROW_GROUP_SIZE,
    kvMetadata: [GEO_METADATA],
  });
}

/**
 * Writes one class's archive file from a consistent paged snapshot, one
 * bounded row group at a time. Every class has its own file, because each
 * class has its own columns: an archive of everything is four files.
 */
export async function writeRecordArchive(
  cls: RecordClass,
  pages: AsyncIterable<readonly ArchivableRecord[]>,
  now: string,
  writer: Writer,
  opts: ArchiveOptions = {},
): Promise<void> {
  const columns = recordArchiveColumns(cls);
  async function* rows(): AsyncGenerator<Record<string, unknown>> {
    for await (const page of pages) {
      for (const record of publishedRecords(cls, page, now, opts)) {
        yield Object.fromEntries(columns.map((c) => [c.name, c.get(record)]));
      }
    }
  }
  await writeArchiveRows(cls, rows(), writer);
}

/** The keys of an archive row an erasure is matched by. */
export interface ArchiveRowKey {
  id: string;
  canonicalId: string;
}

/**
 * Rewrites one class's archive file without the rows `drop` names — an erased
 * record must not stay in a night's file that is kept — copying every other
 * row as it was written, a bounded row group at a time. Returns how many rows
 * went; when none would, `writer` is never asked for and nothing is written.
 */
export async function pruneRecordArchive(
  cls: RecordClass,
  filePath: string,
  drop: (key: ArchiveRowKey) => boolean,
  writer: () => Writer,
): Promise<number> {
  const file = await asyncBufferFromFile(filePath);
  const keys = (await parquetReadObjects({ file, columns: ["id", "canonical_id"] })).map(
    (r): ArchiveRowKey => ({ id: r["id"] as string, canonicalId: r["canonical_id"] as string }),
  );
  const dropped = keys.filter(drop).length;
  if (dropped === 0) return 0;
  async function* rows(): AsyncGenerator<Record<string, unknown>> {
    for (let start = 0; start < keys.length; start += ROW_GROUP_SIZE) {
      const page = await parquetReadObjects({
        file,
        rowStart: start,
        rowEnd: Math.min(start + ROW_GROUP_SIZE, keys.length),
        // The geometry is copied as the WKB bytes it was written as; the
        // string columns are annotated as such and still read as strings.
        geoparquet: false,
        utf8: false,
      });
      for (const [i, row] of page.entries()) {
        if (!drop(keys[start + i]!)) yield row;
      }
    }
  }
  await writeArchiveRows(cls, rows(), writer());
  return dropped;
}
