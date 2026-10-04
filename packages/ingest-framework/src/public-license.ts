import { createHash } from "node:crypto";
import { LICENSES, type LicenseInfo, licenseInfo } from "./catalog/licenses.js";

/**
 * Whether data under a licence may leave in the public scope: the registry
 * grants redistribution affirmatively and the licence is not share-alike.
 * An absent licence, `NOASSERTION` (rights not stated) and an id the
 * registry does not know are not public: lookup is exact, so a misspelt or
 * unregistered share-alike id must never pass.
 */
export function isPublicLicense(license: string | null | undefined): boolean {
  if (!license) return false;
  const info = licenseInfo(license);
  return info !== undefined && !info.shareAlike && info.redistribution === true;
}

/**
 * A stable hash (SHA-256, hex) of what {@link isPublicLicense} reads from the
 * licence registry: each entry's id, redistribution grant and share-alike
 * flag, in id order. Fusions record the hash they were refreshed under, so a
 * registry change that reclassifies a licence refreshes them.
 */
export function publicLicenseClassification(
  licenses: readonly Pick<LicenseInfo, "id" | "redistribution" | "shareAlike">[] = LICENSES,
): string {
  const entries = licenses
    .map((l) => [l.id, l.redistribution, l.shareAlike] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
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
 * Whether a model record may leave in the public scope: its own licence and
 * every licence an upstream publisher states are public, because an
 * aggregator's record carries the most restrictive terms of the chain that
 * relayed it. An upstream entry stating no licence of its own is covered by
 * the record's.
 */
export function isPublicRecord(record: EgressRecord): boolean {
  const { attribution, upstream } = record.provenance;
  return (
    isPublicLicense(attribution.license) &&
    (upstream ?? []).every((u) => u.license === undefined || isPublicLicense(u.license))
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
 * Model records prepared for the public scope: records whose licence is not
 * public dropped, the reporter stripped from every survivor, and sources
 * whose licence is not public removed from a survivor's merged sources, so
 * a withheld publisher's trace never rides along on a public record.
 */
export function publicRecords<T extends EgressRecord>(records: readonly T[]): T[] {
  return records.filter(isPublicRecord).map((record) => {
    const stripped = withoutReporter(record);
    const merged = stripped.provenance.mergedSources;
    if (merged === undefined) return stripped;
    const clean = merged.filter((m) => isPublicLicense(m.attribution.license));
    if (clean.length === merged.length) return stripped;
    const { mergedSources: _merged, ...provenance } = stripped.provenance;
    return {
      ...stripped,
      provenance: clean.length === 0 ? provenance : { ...provenance, mergedSources: clean },
    } as T;
  });
}
