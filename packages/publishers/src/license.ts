import { licenseInfo } from "@openconditions/ingest-framework";

/** Share-alike per the license registry. */
export function isShareAlikeLicense(license: string | undefined): boolean {
  if (!license) return false;
  return licenseInfo(license)?.shareAlike ?? false;
}

/**
 * The permissive-export predicate as a plain license check, for emitters that
 * work off raw SQL rows rather than whole records. An absent license is
 * permissive: an undeclared license means the feed's own terms apply, not
 * copyleft. An id the registry does not know is not: lookup is exact, so a
 * misspelt or unregistered share-alike id must never pass as permissive.
 */
export function isPermissiveLicense(license: string | null | undefined): boolean {
  if (!license) return true;
  const info = licenseInfo(license);
  return info !== undefined && !info.shareAlike;
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
