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
 * Prepares a set for a permissive export so no copyleft feed's data leaks into a
 * non-share-alike consumer. Two passes:
 *  1. Drops any record whose PRIMARY license is share-alike. Records with no
 *     declared license are kept (treated as the feed's own terms apply).
 *  2. For each surviving record, strips any `mergedSources` entry whose
 *     `attribution.license` is share-alike — a permissive record that won a
 *     cross-source dedup merge over a share-alike duplicate keeps its own
 *     (permissive) content, but the copyleft source's attribution trace must
 *     not ride along in the lossless emitters (GeoJSON/JSON-LD spread the whole
 *     observation, `mergedSources` included). Non-mutating: a record with no
 *     share-alike merged source is returned as-is; otherwise a shallow copy with
 *     the filtered `mergedSources` is returned, leaving the shared object intact.
 */
export function filterForPermissiveExport(obs: Observation[]): Observation[] {
  const kept = obs.filter((o) => !isShareAlikeLicense(recordLicense(o)));
  return kept.map((o) => {
    const merged = o.mergedSources;
    if (!merged || merged.length === 0) return o;
    const clean = merged.filter((m) => !isShareAlikeLicense(m.attribution.license));
    if (clean.length === merged.length) return o;
    return { ...o, mergedSources: clean };
  });
}
