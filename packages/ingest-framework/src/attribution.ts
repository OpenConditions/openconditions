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
