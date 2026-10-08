import { promisify } from "node:util";
import { constants, gunzip, gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** A payload kept between polls larger than this is kept gzipped. */
export const HOLD_GZIP_BYTES = 1024 * 1024;

/**
 * A payload kept between polls: as fetched, or gzipped when larger than
 * {@link HOLD_GZIP_BYTES}, since a national register's CSV or JSON shrinks
 * several times over and is read again only for a full parse.
 */
export interface HeldPayload {
  readonly data: Buffer;
  readonly gzipped: boolean;
  /** The payload's own size, as fetched. */
  readonly bytes: number;
}

/** Keeps `buffer`, gzipped when large; compression runs off the event loop. */
export async function holdPayload(buffer: Buffer): Promise<HeldPayload> {
  if (buffer.length <= HOLD_GZIP_BYTES) {
    return { data: buffer, gzipped: false, bytes: buffer.length };
  }
  const data = await gzipAsync(buffer, { level: constants.Z_BEST_SPEED });
  return { data, gzipped: true, bytes: buffer.length };
}

/** The payload as fetched. */
export async function heldBuffer(held: HeldPayload): Promise<Buffer> {
  return held.gzipped ? gunzipAsync(held.data) : held.data;
}

/** Every payload as fetched, in order. */
export function heldBuffers(held: readonly HeldPayload[]): Promise<Buffer[]> {
  return Promise.all(held.map(heldBuffer));
}

/** The bytes the payloads take as fetched. */
export function heldBytes(held: readonly HeldPayload[]): number {
  return held.reduce((sum, h) => sum + h.bytes, 0);
}
