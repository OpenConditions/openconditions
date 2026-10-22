/**
 * A peer's archive landed here: what a pull reads first once its cursor is
 * beyond the peer's live window. Each file the peer's signed page names is
 * fetched to a temporary file and checked against the size and SHA-256 the
 * page states; its records — the peer's own, as the pull's filter keeps them
 * — land through the same inbox as a page, features first, then situations,
 * offers and readings. The pages after it carry what changed since the
 * archive's night: a record no newer than one landed here lands as stale, and
 * a retraction ends what the archive still held. Nothing lands of a file that
 * fails its check, and the pull stops there, to try again.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { ingestFederatedPage } from "@openconditions/contributions-api/federation/inbox";
import {
  applyRecordFilter,
  type PeerRecord,
  type RecordFilter,
  type RecordOutboxEntry,
} from "@openconditions/federation";
import type { Registry } from "@openconditions/model";
import { readRecordArchive } from "@openconditions/publishers";
import type postgres from "postgres";
import { ARCHIVE_CLASSES, type ArchiveFile, type ArchiveManifest } from "./archive.js";

/** How long one archive file may take to arrive. */
export const ARCHIVE_FILE_TIMEOUT_MS = 60 * 60 * 1000;

/** The largest archive file a pull fetches. */
export const ARCHIVE_FILE_MAX_BYTES = 32 * 1024 ** 3;

export interface ArchiveImportContext {
  registry: Registry;
  localInstanceId: string;
  /** The schema versions the peer advertises. */
  peerVersions: readonly string[];
  /** Fetches the archive's files; its size cap must allow them. */
  fetchImpl: typeof fetch;
  now: () => string;
}

export type ArchiveImport =
  | { ok: true; accepted: number; stale: number; skipped: number }
  | {
      ok: false;
      error: string /** A file is not the one the signed page states. */;
      forged?: true;
    };

type Rec = Record<string, unknown>;

/** Fetches `file` to `to`, checked against its size and SHA-256; the failure, or undefined. */
async function download(
  fetchImpl: typeof fetch,
  file: ArchiveFile,
  to: string,
): Promise<{ error: string; forged?: true } | undefined> {
  if (file.bytes > ARCHIVE_FILE_MAX_BYTES) {
    return { error: `the archive file ${file.url} is larger than ${ARCHIVE_FILE_MAX_BYTES} bytes` };
  }
  let res: Response;
  try {
    res = await fetchImpl(file.url, { signal: AbortSignal.timeout(ARCHIVE_FILE_TIMEOUT_MS) });
  } catch (err) {
    return { error: `the archive file ${file.url} could not be fetched: ${String(err)}` };
  }
  if (res.status !== 200 || res.body === null) {
    await res.body?.cancel().catch(() => {});
    return { error: `the archive file ${file.url} answered ${res.status}` };
  }
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(
      Readable.fromWeb(res.body as ReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.byteLength;
          if (size > file.bytes) throw new RangeError("larger than stated");
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(to),
    );
  } catch (err) {
    if (err instanceof RangeError) {
      return { error: `the archive file ${file.url} is larger than the page states`, forged: true };
    }
    return { error: `the archive file ${file.url} could not be fetched: ${String(err)}` };
  }
  if (size !== file.bytes || hash.digest("hex") !== file.sha256) {
    return { error: `the archive file ${file.url} is not the one the page states`, forged: true };
  }
  return undefined;
}

/** An archived record as the entry of a page that creates it. */
function entryOf(record: Rec, builtAt: string): RecordOutboxEntry {
  return {
    seq: 0,
    txid: "0",
    operation: "create",
    recordClass: record["class"] as RecordOutboxEntry["recordClass"],
    recordId: record["id"] as string,
    canonicalId: (record["canonicalId"] as string | undefined) ?? null,
    kind: record["kind"] as string,
    domain: record["domain"] as string,
    ...(typeof record["property"] === "string" ? { property: record["property"] } : {}),
    createdAt: builtAt,
    record: record as unknown as NonNullable<RecordOutboxEntry["record"]>,
  };
}

/** Lands `peer`'s archive `manifest`; never throws for what the peer serves. */
export async function importArchive(
  sql: postgres.Sql,
  peer: PeerRecord & { pull: { filter: RecordFilter } },
  manifest: ArchiveManifest,
  ctx: ArchiveImportContext,
): Promise<ArchiveImport> {
  const counts = { accepted: 0, stale: 0, skipped: 0 };
  const dir = await mkdtemp(path.join(tmpdir(), "oc-archive-"));
  try {
    for (const cls of ARCHIVE_CLASSES) {
      const local = path.join(dir, `${cls}.parquet`);
      const failed = await download(ctx.fetchImpl, manifest.files[cls], local);
      if (failed !== undefined) return { ok: false, ...failed };
      // A file that checks out but does not read is the peer's; a failure to
      // land what it holds is this instance's, and propagates.
      let landing = false;
      try {
        for await (const records of readRecordArchive(local)) {
          const own = records.filter(
            (r) =>
              r["class"] === cls &&
              (r["provenance"] as Rec | undefined)?.["instanceId"] === peer.instanceId,
          );
          const entries = applyRecordFilter(
            own.map((r) => entryOf(r, manifest.builtAt)),
            peer.pull.filter,
            ctx.now(),
          );
          if (entries.length === 0) continue;
          landing = true;
          const landed = await ingestFederatedPage(
            sql,
            { type: "OrderedCollectionPage", orderedItems: entries },
            {
              registry: ctx.registry,
              localInstanceId: ctx.localInstanceId,
              peerInstanceId: peer.instanceId,
              peerVersions: ctx.peerVersions,
              now: ctx.now(),
            },
          );
          landing = false;
          counts.accepted += landed.accepted;
          counts.stale += landed.stale;
          counts.skipped += landed.skipped.length;
        }
      } catch (err) {
        if (landing) throw err;
        return {
          ok: false,
          error: `the archive file ${manifest.files[cls].url} could not be read: ${String(err)}`,
          forged: true,
        };
      }
      await rm(local, { force: true });
    }
    return { ok: true, ...counts };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
