import type { Observation } from "@openconditions/core";
import { licenseInfo } from "@openconditions/ingest-framework";

/** Fallback SPDX/short ids of share-alike (copyleft) licenses not (yet) in the
 *  registry. Matched case-insensitively. */
const SHARE_ALIKE_FALLBACK = ["cc-by-sa", "odbl", "gpl", "agpl", "cc-sa"];

/** The license carried on a record (from its feed provenance). */
export function recordLicense(o: Observation): string | undefined {
  return o.origin.attribution.license;
}

/** Share-alike per the license registry; falls back to substrings for unregistered ids. */
export function isShareAlikeLicense(license: string | undefined): boolean {
  if (!license) return false;
  const info = licenseInfo(license);
  if (info) return info.shareAlike;
  const l = license.toLowerCase();
  return SHARE_ALIKE_FALLBACK.some((s) => l.includes(s));
}

/**
 * Drops share-alike records from a set destined for a permissive export, so a
 * copyleft feed's data never leaks into a non-share-alike consumer. Records with
 * no declared license are kept (treated as the feed's own terms apply).
 */
export function filterForPermissiveExport(obs: Observation[]): Observation[] {
  return obs.filter((o) => !isShareAlikeLicense(recordLicense(o)));
}
