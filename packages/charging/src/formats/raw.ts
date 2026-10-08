/** A parsed JSON object whose members the format reads one by one. */
export type Raw = Record<string, unknown>;

export const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed non-empty string, or a number as text; undefined for anything else. */
export const text = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t === "" ? undefined : t;
};

/** A positive number written as a number or as text (`"230"`, `"3,5"`). */
export const positiveNumber = (value: unknown): number | undefined => {
  const t = text(value);
  const n = t === undefined ? Number.NaN : Number(t.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** A positive whole number written as a number or as text. */
export const positiveInteger = (value: unknown): number | undefined => {
  const n = positiveNumber(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
};

/** A `[lon, lat]` the model can place: inside the globe and not the null island. */
export function placeAt(lat: number, lon: number): [number, number] | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return undefined;
  return [lon, lat];
}

/** The `[lon, lat]` of a coordinate written with a decimal comma or point. */
export function placeFromText(lat: unknown, lon: unknown): [number, number] | undefined {
  const toNumber = (v: unknown) => {
    const t = text(v);
    return t === undefined ? Number.NaN : Number(t.replace(",", "."));
  };
  return placeAt(toNumber(lat), toNumber(lon));
}
