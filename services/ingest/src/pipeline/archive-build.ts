import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { scanLatestObservations, scanRecords } from "@openconditions/core/server";
import type { RecordClass } from "@openconditions/model";
import {
  type ArchivableRecord,
  type ArchiveRowKey,
  pruneRecordArchive,
  writeRecordArchive,
} from "@openconditions/publishers";
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
  /** Nights of dated files to keep; else env `OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS`, else 30. */
  keepNights?: number;
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

const DATED_ARCHIVE = /^archive-(situation|feature|offer|observation)-\d{4}-\d{2}-\d{2}\.parquet$/;

/**
 * Removes erased records from every dated archive file kept in `dir`. Dated
 * files are never pruned by age, so an erasure must reach them: a record
 * tombstoned `rights_revoked` (by id) and a canonical id whose erasure fact
 * is in force (by canonical id, as the inbox refuses it) are dropped from
 * each file that holds them, which is rewritten in place — and the class's
 * stable name moved with it when it points there. Best-effort per file: a
 * file that cannot be rewritten is logged and tried again the next night.
 */
export async function pruneErasedArchives(sql: Sql, dir: string, now: string): Promise<number> {
  const inForce = new Set<string>();
  for (const cls of ["situation", "feature", "offer"] as const) {
    const rows = await sql.unsafe<{ id: string }[]>(
      `SELECT id FROM conditions.${cls} WHERE tombstone_reason = 'rights_revoked'`,
    );
    for (const r of rows) inForce.add(`id:${r.id}`);
  }
  for (const r of await sql<{ canonical_id: string }[]>`
    SELECT canonical_id FROM conditions.federation_tombstone WHERE expires_at > ${now}`) {
    inForce.add(`canonical:${r.canonical_id}`);
  }
  // Only an erasure not yet applied sends the night through the kept files:
  // each file is rewritten once per erasure, not every night it is in force.
  // A file written after an erasure never held the erased content.
  const applied = new Set(
    (await sql<{ key: string }[]>`SELECT key FROM conditions.archive_erasure`).map((r) => r.key),
  );
  const ended = [...applied].filter((key) => !inForce.has(key));
  if (ended.length > 0) await sql`DELETE FROM conditions.archive_erasure WHERE key = ANY(${ended})`;
  const pending = [...inForce].filter((key) => !applied.has(key));
  if (pending.length === 0) return 0;
  const erased = new Set(pending);
  const drop = (key: ArchiveRowKey) =>
    erased.has(`id:${key.id}`) || erased.has(`canonical:${key.canonicalId}`);

  let removed = 0;
  let failed = false;
  for (const name of (await readdir(dir)).sort()) {
    const match = DATED_ARCHIVE.exec(name);
    if (match === null) continue;
    const cls = match[1] as RecordClass;
    const file = path.join(dir, name);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const dropped = await pruneRecordArchive(cls, file, drop, () => fileWriter(temp));
      if (dropped === 0) continue;
      const alias = path.join(dir, latestArchiveFileName(cls));
      const aliased = await sameFile(alias, file);
      await rename(temp, file);
      if (aliased) {
        const aliasTemp = `${alias}.${randomUUID()}.tmp`;
        await link(file, aliasTemp);
        await rename(aliasTemp, alias);
      }
      removed += dropped;
      console.info(`[archive] removed ${dropped} erased record(s) from ${file}`);
    } catch (err) {
      failed = true;
      await rm(temp, { force: true }).catch(() => {});
      console.error(`[archive] failed to remove erased records from ${file}`, err);
    }
  }
  // An erasure is applied once every file is free of it; a file that failed
  // keeps it pending, and the next night tries every file again.
  if (!failed) {
    await sql`
      INSERT INTO conditions.archive_erasure (key)
      SELECT unnest(${pending}::text[]) ON CONFLICT DO NOTHING`;
  }
  return removed;
}

/** Dated archive files kept by default: as far back as a Tier 1 peer's backfill window. */
const DEFAULT_KEEP_NIGHTS = 30;

/** How many nights of dated files to keep (`OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS`; 0 keeps all). */
export function archiveKeepNights(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["OPENCONDITIONS_ARCHIVE_KEEP_NIGHTS"];
  const n = raw == null || raw === "" ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_KEEP_NIGHTS;
}

/**
 * Deletes the dated files of every night but the newest `keepNights`, all
 * classes alike; the stable names point at the newest night and stay.
 */
async function pruneOldNights(dir: string, keepNights: number): Promise<void> {
  if (keepNights === 0) return;
  const dated = (await readdir(dir)).flatMap((name) => {
    const match = DATED_ARCHIVE.exec(name);
    return match === null ? [] : [{ name, day: name.slice(-"YYYY-MM-DD.parquet".length, -8) }];
  });
  const kept = new Set([...new Set(dated.map((f) => f.day))].sort().slice(-keepNights));
  for (const { name, day } of dated) {
    if (!kept.has(day)) await rm(path.join(dir, name), { force: true });
  }
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
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
    try {
      await pruneOldNights(dir, deps.keepNights ?? archiveKeepNights());
    } catch (err) {
      console.error(`[archive] failed to remove old nights from ${dir}`, err);
    }
    try {
      await pruneErasedArchives(sql, dir, nowIso);
    } catch (err) {
      console.error(`[archive] failed to remove erased records from ${dir}`, err);
    }
    return result;
  } catch (err) {
    await Promise.all(temporary.map((t) => rm(t, { force: true }).catch(() => {})));
    console.error(`[archive] failed to write the ${day} archive in ${dir}`, err);
    return null;
  }
}
