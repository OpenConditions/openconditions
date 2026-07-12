import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readObservations } from "@openconditions/core";
import { dailyGeoParquet } from "@openconditions/publishers";
import type postgres from "postgres";

type Sql = postgres.Sql;

/** Where dated archive files land when no dir is configured. Deliberately a
 * local path — object storage / S3 upload is operator infra, not wired here. */
const DEFAULT_ARCHIVE_DIR = "./data/archive";

/** Whole-planet bbox: the archive is the global published view, not bbox-scoped. */
const WORLD_BBOX: [number, number, number, number] = [-180, -90, 180, 90];

/** Mirrors `readObservations`' internal `LIMIT`; a full read here means the
 * archive is silently truncated and needs a paged read (documented follow-up). */
const READ_LIMIT = 2000;

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
function runner(sql: Sql) {
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
 * `readObservations` already SQL-filters to the active, in-validity, unexpired
 * view; `dailyGeoParquet` then re-applies the authoritative published-view
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

  const obs = await readObservations(runner(sql), { bbox: WORLD_BBOX });
  if (obs.length >= READ_LIMIT) {
    console.warn(
      `[archive] read returned the ${READ_LIMIT}-row cap — the archive is likely truncated; a paged read is needed`
    );
  }
  const buffer = await dailyGeoParquet(obs, nowIso);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(outPath, buffer);
  } catch (err) {
    console.error(`[archive] failed to write ${outPath}`, err);
    return null;
  }
  console.info(`[archive] wrote ${outPath} (${buffer.byteLength} bytes)`);
  return { path: outPath, bytes: buffer.byteLength };
}
