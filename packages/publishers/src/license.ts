import { licenseInfo } from "@openconditions/ingest-framework";

/** Fallback SPDX/short ids of share-alike (copyleft) licenses not (yet) in the
 *  registry. Matched case-insensitively. */
const SHARE_ALIKE_FALLBACK = ["cc-by-sa", "odbl", "gpl", "agpl", "cc-sa"];

/** Share-alike per the license registry; falls back to substrings for unregistered ids. */
export function isShareAlikeLicense(license: string | undefined): boolean {
  if (!license) return false;
  const info = licenseInfo(license);
  if (info) return info.shareAlike;
  const l = license.toLowerCase();
  return SHARE_ALIKE_FALLBACK.some((s) => l.includes(s));
}

/**
 * The permissive-export predicate as a plain license check, for emitters that
 * work off raw SQL rows rather than whole records. An absent license is
 * permissive: an undeclared license means the feed's own terms apply, not
 * copyleft.
 */
export function isPermissiveLicense(license: string | null | undefined): boolean {
  return !isShareAlikeLicense(license ?? undefined);
}

/** The parts of a model record licence egress reads. */
export interface EgressRecord {
  provenance: {
    attribution: { license: string };
    upstream?: readonly { license?: string }[];
    mergedSources?: readonly { attribution: { license: string } }[];
    reporter?: unknown;
  };
}

/**
 * Whether a model record may leave under permissive terms: its own licence
 * and every upstream publisher's are permissive, because an aggregator's
 * record carries the most restrictive terms of the chain that relayed it.
 */
export function isPermissiveRecord(record: EgressRecord): boolean {
  const { attribution, upstream } = record.provenance;
  return (
    isPermissiveLicense(attribution.license) &&
    (upstream ?? []).every((u) => isPermissiveLicense(u.license))
  );
}

/**
 * The record as every public projection sees it: without the crowd
 * reporter's key, which would let anyone cluster one reporter's reports.
 */
export function withoutReporter<T extends EgressRecord>(record: T): T {
  if (record.provenance.reporter === undefined) return record;
  const { reporter: _reporter, ...provenance } = record.provenance;
  return { ...record, provenance } as T;
}

/**
 * Model records prepared for a permissive export: share-alike records
 * dropped, the reporter stripped from every survivor, and share-alike
 * sources removed from a survivor's merged sources, so a copyleft
 * publisher's trace never rides along on a permissive record.
 */
export function permissiveRecords<T extends EgressRecord>(records: readonly T[]): T[] {
  return records.filter(isPermissiveRecord).map((record) => {
    const stripped = withoutReporter(record);
    const merged = stripped.provenance.mergedSources;
    if (merged === undefined) return stripped;
    const clean = merged.filter((m) => isPermissiveLicense(m.attribution.license));
    if (clean.length === merged.length) return stripped;
    const { mergedSources: _merged, ...provenance } = stripped.provenance;
    return {
      ...stripped,
      provenance: clean.length === 0 ? provenance : { ...provenance, mergedSources: clean },
    } as T;
  });
}
