import { mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileWriter } from "hyparquet-writer";
import path from "node:path";
import { scanObservations } from "@openconditions/core";
import { writeDailyGeoParquet } from "@openconditions/publishers";
import type postgres from "postgres";

type Sql = postgres.Sql;

/** Where dated archive files land when no dir is configured. Deliberately a
 * local path — object storage / S3 upload is operator infra, not wired here. */
const DEFAULT_ARCHIVE_DIR = "./data/archive";

export interface ArchiveBuildDeps {
  /** Injectable clock; defaults to the real wall clock (runtime, not pure). */
  now?: () => Date;
  /** Output-dir override; else env `OPENCONDITIONS_ARCHIVE_DIR`, else the default. */
  outputDir?: string;
}

export interface ArchiveBuildResult {
  path: string;
  bytes: number;
}

function resolveOutputDir(override?: string): string {
  // `||`, not `??`: Compose injects an empty string for an unset `${VAR:-}`,
  // which must fall through to the default rather than become the output dir.
  return override || process.env.OPENCONDITIONS_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
}

/** Adapt postgres-js to the QueryRunner (`execute`) interface the readers expect. */
function runner(sql: Sql | postgres.TransactionSql) {
  return {
    async execute<T = unknown>(q: string, p?: unknown[]): Promise<T> {
      const rows = p ? await sql.unsafe(q, p as never[]) : await sql.unsafe(q);
      return rows as T;
    },
  };
}

/**
 * Builds the nightly static archive — the mirrorable GeoParquet snapshot of the
 * published view across all domains, written to a dated file in the archive dir.
 *
 * A repeatable-read transaction pages the active, in-validity, unexpired
 * view; the streaming GeoParquet writer re-applies the authoritative published-view
 * filter (license, tombstone, expiry, privacy tier, crowd-identity strip), so
 * the artifact can never carry raw crowd evidence, probe staging, expired, or
 * tombstoned rows.
 *
 * Best-effort: an unwritable/misconfigured output dir is logged and swallowed
 * (returns `null`) so a failed archive write never crashes the scheduler.
 */
export async function buildDailyArchive(
  sql: Sql,
  deps: ArchiveBuildDeps = {}
): Promise<ArchiveBuildResult | null> {
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const dir = resolveOutputDir(deps.outputDir);
  const outPath = path.join(dir, `archive-${nowIso.slice(0, 10)}.parquet`);

  const temporaryPath = `${outPath}.${randomUUID()}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    const writer = fileWriter(temporaryPath);
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      await writeDailyGeoParquet(scanObservations(runner(tx), { asOf: nowIso }), nowIso, writer);
    });
    const { size: bytes } = await stat(temporaryPath);
    await rename(temporaryPath, outPath);
    console.info(`[archive] wrote ${outPath} (${bytes} bytes)`);
    return { path: outPath, bytes };
  } catch (err) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    console.error(`[archive] failed to write ${outPath}`, err);
    return null;
  }
}
