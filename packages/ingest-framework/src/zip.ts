import { crc32, inflateRawSync } from "node:zlib";

const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const STORED = 0;
const DEFLATE = 8;
const FLAG_ENCRYPTED = 0x1;

export interface UnzipOptions {
  /** Only entries whose name matches; all entries without it. */
  entries?: RegExp;
  /** The most entries the archive may list, directories included. */
  maxEntries: number;
  /** The most bytes the selected entries may inflate to, together. */
  maxBytes: number;
}

interface DirectoryEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** The end of central directory record: searched back from the end, past a comment of any length. */
function endRecordOffset(zip: Buffer): number {
  const floor = Math.max(0, zip.length - END_RECORD_BYTES - MAX_COMMENT_BYTES);
  for (let i = zip.length - END_RECORD_BYTES; i >= floor; i--) {
    if (zip.readUInt32LE(i) === END_OF_DIRECTORY) return i;
  }
  throw new Error("unzip: not a zip archive (no end of central directory)");
}

function directory(zip: Buffer, maxEntries: number): DirectoryEntry[] {
  const end = endRecordOffset(zip);
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const offset = zip.readUInt32LE(end + 16);
  // A ZIP64 archive says so with a locator before the end record, or with
  // saturated fields in it; its entries could outgrow every bound below.
  const locator = end >= 20 && zip.readUInt32LE(end - 20) === ZIP64_LOCATOR;
  if (locator || count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new Error("unzip: ZIP64 archives are refused");
  }
  if (count > maxEntries) {
    throw new Error(`unzip: the archive lists ${count} entries, more than ${maxEntries}`);
  }
  if (offset + size > end) throw new Error("unzip: corrupt central directory");

  const entries: DirectoryEntry[] = [];
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== DIRECTORY_ENTRY) {
      throw new Error("unzip: corrupt central directory");
    }
    const flags = zip.readUInt16LE(at + 8);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    if (flags & FLAG_ENCRYPTED) throw new Error(`unzip: entry ${name} is encrypted`);
    const entry: DirectoryEntry = {
      name,
      method: zip.readUInt16LE(at + 10),
      crc: zip.readUInt32LE(at + 16),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      localOffset: zip.readUInt32LE(at + 42),
    };
    if (
      entry.compressedSize === 0xffffffff ||
      entry.size === 0xffffffff ||
      entry.localOffset === 0xffffffff
    ) {
      throw new Error("unzip: ZIP64 archives are refused");
    }
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** An entry's bytes as stored, after its local header. */
function storedData(zip: Buffer, entry: DirectoryEntry): Buffer {
  const at = entry.localOffset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL_HEADER) {
    throw new Error(`unzip: corrupt local header for ${entry.name}`);
  }
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const stop = start + entry.compressedSize;
  if (stop > zip.length) throw new Error(`unzip: entry ${entry.name} runs past the archive`);
  return zip.subarray(start, stop);
}

/**
 * The entries of a zip archive, in name order: stored or deflated ones only,
 * each checked against its CRC-32. Bounded before any work is done on the
 * archive's say-so: the number of entries it lists, and the bytes the
 * selected entries inflate to together, whatever their headers declare.
 * ZIP64 archives and encrypted entries are refused; directories are skipped.
 */
export function unzipEntries(zip: Buffer, opts: UnzipOptions): { name: string; data: Buffer }[] {
  const selected = directory(zip, opts.maxEntries)
    .filter((entry) => !entry.name.endsWith("/"))
    .filter((entry) => opts.entries === undefined || opts.entries.test(entry.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let total = 0;
  const out: { name: string; data: Buffer }[] = [];
  for (const entry of selected) {
    const remaining = opts.maxBytes - total;
    const raw = storedData(zip, entry);
    let data: Buffer;
    if (entry.method === STORED) {
      if (raw.length > remaining) {
        throw new Error(`unzip: the entries inflate past ${opts.maxBytes} bytes`);
      }
      data = raw;
    } else if (entry.method === DEFLATE) {
      try {
        // One byte over the remaining budget tells an entry that fits exactly
        // from one that would go on.
        data = inflateRawSync(raw, { maxOutputLength: remaining + 1 });
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error(`unzip: the entries inflate past ${opts.maxBytes} bytes`);
        }
        throw new Error(`unzip: entry ${entry.name} does not inflate: ${(err as Error).message}`);
      }
      if (data.length > remaining) {
        throw new Error(`unzip: the entries inflate past ${opts.maxBytes} bytes`);
      }
    } else {
      throw new Error(`unzip: entry ${entry.name} uses compression method ${entry.method}`);
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc) {
      throw new Error(`unzip: entry ${entry.name} fails its size or CRC checksum`);
    }
    total += data.length;
    out.push({ name: entry.name, data });
  }
  return out;
}
