import { licenseInfo } from "./licenses.js";

/**
 * The attribution string a consumer must display for a record, or undefined when
 * the license requires none. Unregistered licenses default to "attribution
 * required" (the safe choice — never silently drop credit).
 */
export function attributionLine(license: string, attribution: string): string | undefined {
  const info = licenseInfo(license);
  if (info && !info.attributionRequired) return undefined;
  return attribution;
}
