/**
 * The static archive a peer catches up from once its cursor is beyond its
 * live window: the latest nightly file of each record class
 * (`conditions.archive_file`, noted by the ingest's archive build), named in
 * the signed page with its SHA-256 and size, so each file is as trustworthy
 * as the page though any mirror may serve it.
 */
import type { RecordClass } from "@openconditions/model";
import type postgres from "postgres";

/** The archive's classes, in the order a peer lands them: features before what refers to them. */
export const ARCHIVE_CLASSES: readonly RecordClass[] = [
  "feature",
  "situation",
  "offer",
  "observation",
];

export interface ArchiveFile {
  url: string;
  /** The file's SHA-256, hex. */
  sha256: string;
  bytes: number;
}

export interface ArchiveManifest {
  /** When the night's build began: the archive holds what was current then. */
  builtAt: string;
  files: Record<RecordClass, ArchiveFile>;
}

/** The latest archive under `baseUrl`; undefined until a night noted every class. */
export async function loadArchive(
  sql: postgres.Sql,
  baseUrl: string,
): Promise<ArchiveManifest | undefined> {
  const rows = await sql<
    {
      record_class: RecordClass;
      file_name: string;
      sha256: string;
      bytes: string;
      built_at: Date;
    }[]
  >`SELECT record_class, file_name, sha256, bytes::text AS bytes, built_at
      FROM conditions.archive_file`;
  if (!ARCHIVE_CLASSES.every((cls) => rows.some((r) => r.record_class === cls))) return undefined;
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const builtAt = rows.reduce((at, r) => (r.built_at < at ? r.built_at : at), rows[0]!.built_at);
  return {
    builtAt: builtAt.toISOString(),
    files: Object.fromEntries(
      rows.map((r) => [
        r.record_class,
        {
          url: `${base}/${encodeURIComponent(r.file_name)}`,
          sha256: r.sha256,
          bytes: Number(r.bytes),
        },
      ]),
    ) as Record<RecordClass, ArchiveFile>,
  };
}

const isHttpUrl = (value: unknown): value is string =>
  typeof value === "string" && URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);

/** The archive a peer's signed page names, checked; null when it is malformed. */
export function readArchiveManifest(value: unknown): ArchiveManifest | null {
  if (value === null || typeof value !== "object") return null;
  const { builtAt, files } = value as { builtAt?: unknown; files?: unknown };
  if (typeof builtAt !== "string" || Number.isNaN(Date.parse(builtAt))) return null;
  if (files === null || typeof files !== "object") return null;
  const checked = {} as Record<RecordClass, ArchiveFile>;
  for (const cls of ARCHIVE_CLASSES) {
    const file = (files as Record<string, unknown>)[cls] as Partial<ArchiveFile> | undefined;
    if (
      file === undefined ||
      !isHttpUrl(file.url) ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      return null;
    }
    checked[cls] = { url: file.url, sha256: file.sha256, bytes: file.bytes };
  }
  return { builtAt: new Date(builtAt).toISOString(), files: checked };
}
