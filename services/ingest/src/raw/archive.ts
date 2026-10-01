import type { RawTier } from "@openconditions/core/server";
import {
  fsRawPayloadSink,
  type PayloadDigest,
  type RawPayloadSink,
  type RawPayloadWriter,
} from "@openconditions/ingest-framework";
import type postgres from "postgres";

/** Where one raw payload came from and how long it may be kept. */
export interface CaptureMeta {
  sourceId: string;
  /** The poll attempt that fetched it. */
  fetchId: number;
  fetchedAt: Date;
  tier: RawTier;
  /** The response URL, credentials redacted. */
  url: string;
}

/**
 * Archives a poll's raw payloads: each distinct decoded response once per
 * source, as a zstd blob on disk indexed in `conditions.raw_payload`. A
 * payload already held is only counted again (`last_seen_at`, `seen_count`);
 * one evicted earlier is written again. Never throws: archiving must not
 * fail a poll, so a failure is logged and the poll goes on.
 */
export interface RawArchive {
  /** Archives a buffered response. */
  capture(meta: CaptureMeta, body: Buffer, digest: PayloadDigest): Promise<void>;
  /** A writer to tee a streamed response into while it is parsed; undefined when none could be opened. */
  writer(meta: CaptureMeta): Promise<RawPayloadWriter | undefined>;
  /**
   * Archives a streamed response once its digest is known, unless the payload
   * is already held; a stream that failed is aborted instead (`digest` absent).
   */
  finish(meta: CaptureMeta, writer: RawPayloadWriter, digest?: PayloadDigest): Promise<void>;
}

/** Root directory and compression of the raw archive, from the environment. */
export function rawArchiveOptionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const level = Number(env["OPENCONDITIONS_RAW_ZSTD_LEVEL"] || 9);
  return {
    dir: env["OPENCONDITIONS_RAW_DIR"] || "./data/raw",
    zstdLevel: Number.isInteger(level) && level >= 1 && level <= 22 ? level : 9,
  };
}

export function createRawArchive(
  sql: postgres.Sql,
  opts: { dir: string; zstdLevel?: number; sink?: RawPayloadSink },
): RawArchive {
  const sink = opts.sink ?? fsRawPayloadSink({ dir: opts.dir, zstdLevel: opts.zstdLevel ?? 9 });

  /** True when the payload is held and not evicted; then it is only counted as seen again. */
  async function seenAgain(meta: CaptureMeta, hash: string): Promise<boolean> {
    const rows = await sql`
      UPDATE conditions.raw_payload
         SET last_seen_at = GREATEST(last_seen_at, ${meta.fetchedAt}), seen_count = seen_count + 1
       WHERE source_id = ${meta.sourceId} AND hash = ${hash} AND evicted_at IS NULL
       RETURNING hash`;
    return rows.length > 0;
  }

  async function index(
    meta: CaptureMeta,
    digest: PayloadDigest,
    stored: { storageKey: string; bytesStored: number },
  ) {
    await sql`
      INSERT INTO conditions.raw_payload (source_id, hash, url_key, fetch_id, bytes_raw,
        bytes_stored, first_fetched_at, last_seen_at, seen_count, tier, storage_key)
      VALUES (${meta.sourceId}, ${digest.sha256}, ${digest.url}, ${meta.fetchId}, ${digest.bytes},
        ${stored.bytesStored}, ${meta.fetchedAt}, ${meta.fetchedAt}, 1, ${meta.tier},
        ${stored.storageKey})
      ON CONFLICT (source_id, hash) DO UPDATE SET
        storage_key = excluded.storage_key, bytes_stored = excluded.bytes_stored,
        last_seen_at = excluded.last_seen_at, seen_count = raw_payload.seen_count + 1,
        tier = excluded.tier, evicted_at = NULL`;
  }

  const logFailure = (meta: CaptureMeta, err: unknown) =>
    console.warn(
      `[raw] ${meta.sourceId}: could not archive ${meta.url}:`,
      err instanceof Error ? err.message : err,
    );

  return {
    async capture(meta, body, digest) {
      try {
        if (await seenAgain(meta, digest.sha256)) return;
        const w = await sink.begin({ ...meta, fetchId: String(meta.fetchId) });
        w.write(body);
        await index(meta, digest, await w.commit(digest.sha256));
      } catch (err) {
        logFailure(meta, err);
      }
    },
    async writer(meta) {
      try {
        return await sink.begin({ ...meta, fetchId: String(meta.fetchId) });
      } catch (err) {
        logFailure(meta, err);
        return undefined;
      }
    },
    async finish(meta, writer, digest) {
      try {
        if (digest === undefined || (await seenAgain(meta, digest.sha256))) {
          await writer.abort();
          return;
        }
        await index(meta, digest, await writer.commit(digest.sha256));
      } catch (err) {
        logFailure(meta, err);
        await writer.abort().catch(() => {});
      }
    },
  };
}
