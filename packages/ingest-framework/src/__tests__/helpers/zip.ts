import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntrySpec {
  name: string;
  data: Buffer | string;
  /** 0 stored, 8 deflate; deflate by default. */
  method?: 0 | 8;
  /** General-purpose flags; bit 0 marks an encrypted entry. */
  flags?: number;
  /** The uncompressed size the headers declare, when it should differ from the data's. */
  declaredSize?: number;
}

/**
 * A zip archive built byte by byte, so a test controls what the headers say:
 * local headers and data, the central directory, an optional ZIP64 end record
 * and locator, and the end of central directory record.
 */
export function buildZip(entries: ZipEntrySpec[], opts: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name);
    const crc = crc32(data);
    const size = entry.declaredSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (opts.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(opts.zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, directory, ...tail, end]);
}
