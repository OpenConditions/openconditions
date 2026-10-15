/** Maintainer-only import of the pinned official VILD point distribution.
 * No TraFFxml code or synthetic ISO/TABCD conversion is used. */
import { createHash } from "node:crypto";

export const VILD_SOURCE = {
  url: "https://opendata.ndw.nu/VILD6.13.A.zip",
  sha256: "d95f14076fb7eb91822944236ba2e68d96a2f59cb533d891580bce6d140a7f95",
  activeSince: "2025-10-22",
  licenseEvidence: "https://data.overheid.nl/dataset/ada74229-474e-4469-adc8-1ad87ef38c36",
};

export function verifyVildArchive(bytes: Buffer): void {
  if (createHash("sha256").update(bytes).digest("hex") !== VILD_SOURCE.sha256) {
    throw new Error("VILD archive SHA-256 differs from the reviewed distribution");
  }
}

type Row = Record<string, string>;

/** Keep deleted-row slots: shapefile geometry and its DBF align by ordinal. */
function dbf(bytes: Buffer): (Row | null)[] {
  if (bytes.length < 33 || bytes[0] !== 3) throw new Error("expected a dBASE III DBF");
  const count = bytes.readUInt32LE(4),
    header = bytes.readUInt16LE(8),
    width = bytes.readUInt16LE(10);
  if (
    header < 33 ||
    (header - 33) % 32 !== 0 ||
    width < 1 ||
    header + count * width > bytes.length ||
    bytes[header - 1] !== 13
  )
    throw new Error("invalid DBF dimensions");
  const fields: { name: string; width: number }[] = [];
  for (let p = 32; p < header - 1; p += 32) {
    const name = bytes
      .subarray(p, p + 11)
      .toString("ascii")
      .replace(/\0.*$/s, "");
    const fieldWidth = bytes.readUInt8(p + 16);
    if (
      !name ||
      fields.some((f) => f.name === name) ||
      !fieldWidth ||
      ![67, 78, 70].includes(bytes.readUInt8(p + 11))
    )
      throw new Error("unsupported DBF field");
    fields.push({ name, width: fieldWidth });
  }
  if (fields.reduce((n, f) => n + f.width, 1) !== width)
    throw new Error("DBF record width mismatch");
  const decoder = new TextDecoder("windows-1252");
  return Array.from({ length: count }, (_, i) => {
    let p = header + i * width;
    const flag = bytes[p++];
    if (flag === 42) return null;
    if (flag !== 32) throw new Error("invalid DBF deletion marker");
    const row: Row = {};
    for (const field of fields) {
      row[field.name] = decoder.decode(bytes.subarray(p, p + field.width)).trim();
      p += field.width;
    }
    return row;
  });
}

function positiveCode(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0)
    throw new Error("invalid VILD location code");
  return Number(raw);
}

function pointShapes(bytes: Buffer): ([number, number] | null)[] {
  if (
    bytes.length < 100 ||
    bytes.readInt32BE(0) !== 9994 ||
    bytes.readInt32LE(28) !== 1000 ||
    bytes.readInt32LE(32) !== 1 ||
    bytes.readInt32BE(24) * 2 !== bytes.length
  )
    throw new Error("invalid point shapefile header");
  const points: ([number, number] | null)[] = [];
  for (let p = 100; p < bytes.length; ) {
    if (p + 12 > bytes.length) throw new Error("truncated point shapefile record");
    const number = bytes.readInt32BE(p),
      length = bytes.readInt32BE(p + 4) * 2,
      type = bytes.readInt32LE(p + 8);
    if (number !== points.length + 1 || length < 4 || p + 8 + length > bytes.length)
      throw new Error("invalid point shapefile record");
    if (type === 0 && length === 4) points.push(null);
    else {
      if (type !== 1 || length !== 20) throw new Error("unsupported shapefile geometry");
      const lon = bytes.readDoubleLE(p + 12),
        lat = bytes.readDoubleLE(p + 20);
      if (
        !Number.isFinite(lon) ||
        !Number.isFinite(lat) ||
        Math.abs(lon) > 180 ||
        Math.abs(lat) > 90
      )
        throw new Error("invalid WGS84 coordinate");
      points.push([Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7]);
    }
    p += 8 + length;
  }
  return points;
}

export interface VildFiles {
  mainDbf: Buffer;
  pointDbf: Buffer;
  pointShp: Buffer;
  projection: string;
}

/** Reject incomplete/ambiguous joins instead of publishing a partial snapshot. */
export function buildVildSnapshot(files: VildFiles) {
  if (
    !files.projection.includes("GEOGCS[") ||
    !/"EPSG"\s*,\s*"4326"/.test(files.projection) ||
    files.projection.includes("PROJCS[")
  )
    throw new Error("expected the WGS84 geographic point distribution");
  const main = dbf(files.mainDbf).filter((r): r is Row => r !== null);
  const versions = main.filter((r) => r["LOC_NR"] === "0" && r["LOC_TYPE"] === "V1.0");
  if (versions.length !== 1 || versions[0]?.["FIRST_NAME"] !== "6.13.A")
    throw new Error("VILD edition differs from reviewed 6.13.A");
  const codes = new Set<string>();
  for (const row of main) {
    const code = row["LOC_NR"];
    if (code === undefined || codes.has(code))
      throw new Error("duplicate/missing main DBF location code");
    codes.add(code);
  }
  const rows = dbf(files.pointDbf),
    shapes = pointShapes(files.pointShp);
  if (rows.length !== shapes.length) throw new Error("point DBF/SHP ordinal join mismatch");
  const byCode = new Map<number, [number, number]>();
  rows.forEach((row, i) => {
    if (!row) return;
    const code = positiveCode(row["LOC_NR"]),
      point = shapes[i];
    if (byCode.has(code)) throw new Error("duplicate point DBF location code");
    if (!point) throw new Error("missing point geometry in join");
    byCode.set(code, point);
  });
  const points: [number, number, number, string][] = [];
  for (const row of main.filter((r) => r["LOC_TYPE"]?.startsWith("P"))) {
    const code = positiveCode(row["LOC_NR"]),
      point = byCode.get(code);
    if (!point) throw new Error(`missing coordinate join for VILD ${code}`);
    points.push([code, ...point, row["ROADNUMBER"] ?? ""]);
    byCode.delete(code);
  }
  if (byCode.size > 0 || points.length === 0) throw new Error("unmatched/empty VILD point join");
  points.sort((a, b) => a[0] - b[0]);
  return {
    edition: "6.13.A",
    reference: { country: "8", table: "6.13", version: "A" },
    attribution: "Rijkswaterstaat / Nationaal Dataportaal Wegverkeer — VILD 6.13.A",
    license: "CC0-1.0",
    source: VILD_SOURCE,
    points,
  };
}
