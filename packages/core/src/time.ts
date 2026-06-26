/**
 * Normalise a timestamp from the many shapes feeds emit — ISO 8601 strings,
 * epoch seconds or milliseconds (as a number or a numeric string), or a `Date` —
 * into a UTC ISO 8601 string. Returns `undefined` for null, empty, or
 * unparseable input, so a single malformed value can never reach a `timestamptz`
 * column and abort a whole batch insert.
 *
 * Epoch heuristic: an absolute value below 1e11 is treated as seconds (1e11 s ≈
 * year 5138, while current epochs are ~1.7e9), otherwise as milliseconds
 * (1e11 ms ≈ 1973).
 */
export function toIsoTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }

  if (typeof value === "number") return fromEpoch(value);

  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return undefined;
    if (/^-?\d+$/.test(s)) return fromEpoch(Number(s));
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }

  return undefined;
}

function fromEpoch(n: number): string | undefined {
  if (!Number.isFinite(n)) return undefined;
  const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
