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
 * Removes the crowd reporter block from an observation's origin, leaving only
 * `{ kind, attribution }`. The reporter's pseudonymous `keyId` (an RFC 7638
 * thumbprint), signature, and reputation are identity-bearing and must never
 * reach a public consumer — a leaked keyId lets anyone cluster all of one
 * reporter's reports, defeating the pseudonymity model. Feed origins carry no
 * reporter, so they pass through by reference unchanged.
 */
function stripReporter(o: Observation): Observation {
  if (!("reporter" in o.origin)) return o;
  // Intentionally a reporter-less origin; the crowd variant nominally requires a
  // reporter, so cast past the union — dropping it is the whole point here.
  const origin = {
    kind: o.origin.kind,
    attribution: o.origin.attribution,
  } as Observation["origin"];
  return { ...o, origin };
}

/**
 * Prepares a set for a permissive, public export. Three concerns, applied to
 * every route/emitter that funnels through this one filter:
 *  1. Drops any record whose PRIMARY license is share-alike so no copyleft
 *     feed's data leaks into a non-share-alike consumer. Records with no
 *     declared license are kept (treated as the feed's own terms apply).
 *  2. Strips `origin.reporter` (keyId/signature/reputation) from every surviving
 *     record so the pseudonymous reporter identity never reaches a public
 *     projection (GeoJSON/JSON-LD/GTFS-RT/TraFF/DATEX/SSE/archive all run this).
 *  3. Strips any `mergedSources` entry whose `attribution.license` is
 *     share-alike — a permissive record that won a cross-source dedup merge over
 *     a share-alike duplicate keeps its own (permissive) content, but the
 *     copyleft source's attribution trace must not ride along in the lossless
 *     emitters (GeoJSON/JSON-LD spread the whole observation, `mergedSources`
 *     included).
 * Non-mutating: a feed record with no share-alike merged source is returned by
 * reference; any record needing a change gets a shallow copy, leaving the shared
 * object intact.
 */
export function filterForPermissiveExport(obs: Observation[]): Observation[] {
  const kept = obs.filter((o) => !isShareAlikeLicense(recordLicense(o)));
  return kept.map((o) => {
    const stripped = stripReporter(o);
    const merged = stripped.mergedSources;
    if (!merged || merged.length === 0) return stripped;
    const clean = merged.filter((m) => !isShareAlikeLicense(m.attribution.license));
    if (clean.length === merged.length) return stripped;
    return { ...stripped, mergedSources: clean };
  });
}
