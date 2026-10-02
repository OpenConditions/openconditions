import { randomUUID } from "node:crypto";
import { link, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { scanLatestObservations, scanRecords } from "@openconditions/core/server";
import type { RecordClass } from "@openconditions/model";
import { type ArchivableRecord, writeRecordArchive } from "@openconditions/publishers";
import { fileWriter } from "hyparquet-writer";
import type postgres from "postgres";

type Sql = postgres.Sql;

/** Where archive files land when no dir is configured. Deliberately a local
 * path — object storage / S3 upload is operator infra, not wired here. */
const DEFAULT_ARCHIVE_DIR = "./data/archive";

/** The archive's classes, one file each: each class has its own columns. */
export const ARCHIVE_CLASSES: readonly RecordClass[] = [
  "situation",
  "feature",
  "offer",
  "observation",
];

/** The dated file of a class's archive. */
export const archiveFileName = (cls: RecordClass, day: string) => `archive-${cls}-${day}.parquet`;

/** The stable name of a class's latest archive, which a peer fetches. */
export const latestArchiveFileName = (cls: RecordClass) => `archive-${cls}.parquet`;

export interface ArchiveBuildDeps {
  /** Injectable clock; defaults to the real wall clock (runtime, not pure). */
  now?: () => Date;
  /** Output-dir override; else env `OPENCONDITIONS_ARCHIVE_DIR`, else the default. */
  outputDir?: string;
}

export type ArchiveBuildResult = Record<RecordClass, { path: string; bytes: number }>;

function resolveOutputDir(override?: string): string {
  // `||`, not `??`: Compose injects an empty string for an unset `${VAR:-}`,
  // which must fall through to the default rather than become the output dir.
  return override || process.env.OPENCONDITIONS_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
}

function pagesOf(
  tx: postgres.TransactionSql,
  cls: RecordClass,
): AsyncIterable<readonly ArchivableRecord[]> {
  const pages = cls === "observation" ? scanLatestObservations(tx) : scanRecords(tx, cls);
  return pages as AsyncIterable<readonly ArchivableRecord[]>;
}

/**
 * Builds the nightly static archive: one GeoParquet file per record class
 * (`archive-<class>-YYYY-MM-DD.parquet`), the live situations, features and
 * offers and the latest reading of every series, and points the class's
 * stable name (`archive-<class>.parquet`) at it. All four read one
 * repeatable-read snapshot. The writer applies the published view
 * (`publishedRecords`: no on-demand answers or fused rows, nothing
 * tombstoned or out of date, crowd records only once corroborated,
 * permissive licences, reporters stripped, a source's extras only when the
 * source federates them), so the artifact carries what a peer may receive.
 *
 * Best-effort: an unwritable or misconfigured output dir is logged and
 * swallowed (returns `null`) so a failed archive write never crashes the
 * scheduler, and no stable name moves unless every class was written.
 */
export async function buildDailyArchive(
  sql: Sql,
  deps: ArchiveBuildDeps = {},
): Promise<ArchiveBuildResult | null> {
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const day = nowIso.slice(0, 10);
  const dir = resolveOutputDir(deps.outputDir);
  const temporary: string[] = [];
  try {
    await mkdir(dir, { recursive: true });
    const federated = new Set(
      (await sql<{ id: string }[]>`SELECT id FROM conditions.source WHERE extras_federate`).map(
        (r) => r.id,
      ),
    );
    const opts = { federateExtras: (sourceId: string) => federated.has(sourceId) };
    const written = {} as Record<RecordClass, { temp: string; path: string }>;
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      for (const cls of ARCHIVE_CLASSES) {
        const outPath = path.join(dir, archiveFileName(cls, day));
        const temp = `${outPath}.${randomUUID()}.tmp`;
        temporary.push(temp);
        await writeRecordArchive(cls, pagesOf(tx, cls), nowIso, fileWriter(temp), opts);
        written[cls] = { temp, path: outPath };
      }
    });
    const result = {} as ArchiveBuildResult;
    for (const cls of ARCHIVE_CLASSES) {
      const { temp, path: outPath } = written[cls];
      const { size: bytes } = await stat(temp);
      await rename(temp, outPath);
      result[cls] = { path: outPath, bytes };
    }
    // The stable names move last, each atomically, once every dated file exists.
    for (const cls of ARCHIVE_CLASSES) {
      const alias = path.join(dir, latestArchiveFileName(cls));
      const aliasTemp = `${alias}.${randomUUID()}.tmp`;
      temporary.push(aliasTemp);
      await link(result[cls].path, aliasTemp);
      await rename(aliasTemp, alias);
    }
    for (const cls of ARCHIVE_CLASSES) {
      console.info(`[archive] wrote ${result[cls].path} (${result[cls].bytes} bytes)`);
    }
    return result;
  } catch (err) {
    await Promise.all(temporary.map((t) => rm(t, { force: true }).catch(() => {})));
    console.error(`[archive] failed to write the ${day} archive in ${dir}`, err);
    return null;
  }
}
