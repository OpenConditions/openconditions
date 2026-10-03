/** One identifier token: operator, subdivision or product. */
export const FEED_TOKEN = /^[a-z0-9]+$/;
/** One or more dash-joined tokens. */
export const FEED_QUALIFIER = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const REGION = /^([a-z]{2}|eu|global)$/;

/** ISO 3166-1 alpha-2 lower case, `eu` or `global`. */
export type Region = string;

/** The region a catalogue file covers, taken from its file name. */
export function regionOfFile(path: string): Region {
  const name =
    path
      .split("/")
      .pop()
      ?.replace(/\.jsonc?$/, "") ?? "";
  if (!REGION.test(name)) {
    throw new Error(`"${path}": file name must be an ISO 3166-1 alpha-2 code, "eu" or "global"`);
  }
  return name;
}

/** A feed's id: region (omitted for `global`), subdivision, operator, qualifier, product. */
export function deriveFeedId(p: {
  region: Region;
  subdivision?: string;
  operator: string;
  qualifier?: string;
  product: string;
}): string {
  return [
    p.region === "global" ? undefined : p.region,
    p.subdivision,
    p.operator,
    p.qualifier,
    p.product,
  ]
    .filter(Boolean)
    .join("-");
}
