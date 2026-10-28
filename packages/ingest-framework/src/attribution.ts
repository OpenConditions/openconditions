import { licenseInfo } from "./catalog/licenses.js";

/**
 * The attribution string a consumer must display for a record, or undefined when
 * the license requires none. A license that is unregistered or does not say
 * defaults to "attribution required" (the safe choice — never silently drop credit).
 */
export function attributionLine(license: string, attribution: string): string | undefined {
  if (licenseInfo(license)?.attributionRequired === false) return undefined;
  return attribution;
}

/**
 * The one placeholder a catalogue `attribution` may write: the year of the
 * data credited, which a notice such as Copernicus's ("Contains modified
 * Copernicus Sentinel data [Year]") requires.
 */
export const ATTRIBUTION_YEAR = "{year}";

/** Every `{…}` token of an attribution that is not {@link ATTRIBUTION_YEAR}. */
export function unknownAttributionPlaceholders(attribution: string): string[] {
  const unknown: string[] = [];
  let from = 0;
  for (let open = attribution.indexOf("{"); open !== -1; open = attribution.indexOf("{", from)) {
    const close = attribution.indexOf("}", open + 1);
    if (close === -1) break;
    const token = attribution.slice(open, close + 1);
    if (token !== ATTRIBUTION_YEAR) unknown.push(token);
    from = close + 1;
  }
  return unknown;
}

/**
 * A catalogue attribution as it is shown for data of the instant `at`: its
 * `{year}` written as that instant's UTC year. Where no record dates the
 * credit (a source listing), `at` is now.
 */
export function resolveAttribution(attribution: string, at: Date): string {
  return attribution.includes(ATTRIBUTION_YEAR)
    ? attribution.replaceAll(ATTRIBUTION_YEAR, String(at.getUTCFullYear()))
    : attribution;
}
