import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, constants as zlib, zstdDecompressSync } from "node:zlib";

/**
 * Identity of one fetched payload: sha256 of the decoded body (after gunzip),
 * so transport compression never changes it. One per HTTP response — multi-URL,
 * fan-out and paginated feeds produce one digest per response.
 */
export interface PayloadDigest {
  /** The response URL with credentials redacted. */
  url: string;
  sha256: string;
  bytes: number;
}

export function digestPayload(url: string, body: Buffer): PayloadDigest {
  return { url, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
}

/**
 * Pass-through stream that hashes every decoded byte on its way to a streaming
 * parser, so a streamed payload gets the same digest a buffered one would.
 * Optionally tees the bytes into a raw-payload writer.
 */
export class DigestTee extends Transform {
  readonly #hash = createHash("sha256");
  #bytes = 0;
  readonly #writer: RawPayloadWriter | undefined;

  constructor(
    readonly url: string,
    writer?: RawPayloadWriter,
  ) {
    super();
    this.#writer = writer;
  }

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.#hash.update(buf);
    this.#bytes += buf.length;
    this.#writer?.write(buf);
    cb(null, buf);
  }

  /** The digest; valid once the stream has ended. */
  digest(): PayloadDigest {
    return { url: this.url, sha256: this.#hash.copy().digest("hex"), bytes: this.#bytes };
  }
}

export interface RawPayloadMeta {
  sourceId: string;
  url: string;
  /** Groups the responses of one poll (the poll attempt id). */
  fetchId: string;
  fetchedAt: Date;
}

export interface StoredRawPayload {
  /** Path relative to the raw root: `<source_id>/<yyyy-mm-dd>/<sha256>.zst`. */
  storageKey: string;
  bytesStored: number;
  /** False when a blob with this hash already existed for the day. */
  created: boolean;
}

/** One raw payload being written: bytes go to a temp file, then land by hash. */
export interface RawPayloadWriter {
  write(chunk: Buffer): void;
  commit(sha256: string): Promise<StoredRawPayload>;
  abort(): Promise<void>;
}

/** Destination for raw payloads. The index table and eviction live with the ingest service. */
export interface RawPayloadSink {
  begin(meta: RawPayloadMeta): Promise<RawPayloadWriter>;
}

const SOURCE_DIR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Filesystem sink: zstd-compressed blobs at
 * `<dir>/<source_id>/<yyyy-mm-dd>/<sha256>.zst`, written to a temp file in the
 * source directory and renamed once the hash is known, so a reader never sees
 * a partial blob and a crash leaves only a `.tmp-*` file behind.
 */
export function fsRawPayloadSink(opts: { dir: string; zstdLevel?: number }): RawPayloadSink {
  const level = opts.zstdLevel ?? 9;
  return {
    async begin(meta) {
      if (!SOURCE_DIR.test(meta.sourceId)) throw new TypeError(`bad source id ${meta.sourceId}`);
      const sourceDir = join(opts.dir, meta.sourceId);
      await mkdir(sourceDir, { recursive: true });
      const tmp = join(sourceDir, `.tmp-${randomUUID()}.zst`);
      const zstd = createZstdCompress({ params: { [zlib.ZSTD_c_compressionLevel]: level } });
      const done = pipeline(zstd, createWriteStream(tmp));
      // Observed in commit/abort; this handler only keeps an early failure from
      // surfacing as an unhandled rejection before either runs.
      done.catch(() => {});
      return {
        write(chunk) {
          zstd.write(chunk);
        },
        async commit(sha256) {
          if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError("sha256 must be 64 hex chars");
          zstd.end();
          try {
            await done;
          } catch (err) {
            await rm(tmp, { force: true });
            throw err;
          }
          const day = meta.fetchedAt.toISOString().slice(0, 10);
          const storageKey = `${meta.sourceId}/${day}/${sha256}.zst`;
          const target = join(opts.dir, storageKey);
          await mkdir(join(sourceDir, day), { recursive: true });
          const existing = await stat(target).catch(() => undefined);
          if (existing) {
            await rm(tmp, { force: true });
            return { storageKey, bytesStored: existing.size, created: false };
          }
          const bytesStored = (await stat(tmp)).size;
          await rename(tmp, target);
          return { storageKey, bytesStored, created: true };
        },
        async abort() {
          zstd.destroy();
          await done.catch(() => {});
          await rm(tmp, { force: true });
        },
      };
    },
  };
}

const STORAGE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{64}\.zst$/;

/** The decoded body of a blob {@link fsRawPayloadSink} stored under `storageKey`. */
export async function readRawPayload(dir: string, storageKey: string): Promise<Buffer> {
  if (!STORAGE_KEY.test(storageKey)) throw new TypeError(`bad storage key ${storageKey}`);
  return zstdDecompressSync(await readFile(join(dir, storageKey)));
}
