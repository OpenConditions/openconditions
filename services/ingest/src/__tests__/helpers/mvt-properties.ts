/** Minimal protobuf reader for inspecting the actual PostGIS MVT attribute contract. */
function varint(bytes: Uint8Array, cursor: { at: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    const byte = bytes[cursor.at++]!;
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
    shift += 7;
    if (shift > 63 || cursor.at > bytes.length) throw new Error("Invalid protobuf varint");
  }
}
function fields(bytes: Uint8Array) {
  const result: { id: number; value: Uint8Array | number }[] = [];
  const cursor = { at: 0 };
  while (cursor.at < bytes.length) {
    const key = varint(bytes, cursor);
    const wire = key & 7;
    const id = key >> 3;
    if (wire === 0) result.push({ id, value: varint(bytes, cursor) });
    else {
      const size = wire === 2 ? varint(bytes, cursor) : wire === 1 ? 8 : wire === 5 ? 4 : 0;
      if (!size && wire !== 2) throw new Error(`Unsupported protobuf wire ${wire}`);
      result.push({ id, value: bytes.subarray(cursor.at, cursor.at + size) });
      cursor.at += size;
    }
  }
  return result;
}
export function mvtProperties(bytes: Uint8Array): Record<string, unknown>[] {
  const text = new TextDecoder();
  const features: Record<string, unknown>[] = [];
  for (const layer of fields(bytes).filter((f) => f.id === 3)) {
    const parts = fields(layer.value as Uint8Array);
    const keys = parts.filter((f) => f.id === 3).map((f) => text.decode(f.value as Uint8Array));
    const values = parts
      .filter((f) => f.id === 4)
      .map((f) => {
        const field = fields(f.value as Uint8Array)[0]!;
        if (field.id === 1) return text.decode(field.value as Uint8Array);
        if (field.id === 3) {
          const b = field.value as Uint8Array;
          return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(0, true);
        }
        if (field.id === 2) {
          const b = field.value as Uint8Array;
          return new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(0, true);
        }
        return field.value;
      });
    for (const feature of parts.filter((f) => f.id === 2)) {
      const tags = fields(feature.value as Uint8Array).find((f) => f.id === 2)?.value as Uint8Array;
      const cursor = { at: 0 };
      const properties: Record<string, unknown> = {};
      while (cursor.at < tags.length) {
        const key = varint(tags, cursor);
        const value = varint(tags, cursor);
        properties[keys[key]!] = values[value];
      }
      features.push(properties);
    }
  }
  return features;
}
