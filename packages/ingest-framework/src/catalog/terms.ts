import { licenseInfo } from "./licenses.js";

/** A feed's own terms, which override its licence field by field. A key that is
 *  set, even to `null`, wins over the licence; an absent or `undefined` key
 *  defers to it. `url` and `reviewedAt` are the evidence the feed's rights rest
 *  on: the publisher's own statement of its licence or terms, and the date
 *  someone read it (see `licenseEvidence`). */
export interface FeedTerms {
  url?: string;
  reviewedAt?: string;
  note?: string;
  /** A notice the publisher requires to accompany any display of its data. */
  notice?: string;
  display?: boolean | null;
  redistribution?: boolean | null;
  derivedRedistribution?: boolean | null;
  commercialUse?: boolean | null;
  attributionRequired?: boolean | null;
  retention?: boolean | null;
}

/** What a feed's licence and terms declare, each grant `null` where they do not say. */
export interface EffectiveRights {
  /** Showing the data, unchanged and credited, to the users of an application. */
  display: boolean | null;
  /** Passing the source data itself on to third parties. */
  redistribution: boolean | null;
  /** Building other data or products from it, and passing those on. */
  derivedRedistribution: boolean | null;
  commercialUse: boolean | null;
  attributionRequired: boolean | null;
  retention: boolean | null;
  shareAlike: boolean;
}

/** The rights that apply to a feed: its licence's, overridden by its own terms.
 *  Throws on a licence id the registry does not know. */
export function effectiveRights(license: string, terms: FeedTerms = {}): EffectiveRights {
  const info = licenseInfo(license);
  if (!info) throw new Error(`unknown licence "${license}"`);
  const right = (key: Exclude<keyof EffectiveRights, "shareAlike">): boolean | null =>
    terms[key] !== undefined ? terms[key] : info[key];
  return {
    display: right("display"),
    redistribution: right("redistribution"),
    derivedRedistribution: right("derivedRedistribution"),
    commercialUse: right("commercialUse"),
    attributionRequired: right("attributionRequired"),
    retention: right("retention"),
    shareAlike: info.shareAlike,
  };
}

/**
 * Where a feed's rights rest: the publisher's own statement of the licence or
 * terms its data comes under, and the date someone read it there. A licence id
 * in the catalogue is a claim; this is what makes it a checked one.
 */
export interface LicenseEvidence {
  url: string;
  reviewedAt: string;
}

/** A feed's licence evidence, or null while its rights claim is unchecked. */
export function licenseEvidence(terms: FeedTerms | undefined): LicenseEvidence | null {
  return terms?.url && terms.reviewedAt ? { url: terms.url, reviewedAt: terms.reviewedAt } : null;
}

/** A use of a feed's data that its rights may permit. */
export type DataUse = "display" | "redistribute" | "derive" | "retain" | "commercial";

/**
 * Whether a use is permitted: `yes` when the rights grant it and rest on
 * evidence, `no` when they deny it (a denial needs no evidence to be heeded),
 * `unknown` when they do not say or the claim that they grant it is unchecked.
 */
export type Permission = "yes" | "no" | "unknown";

export type Permissions = Record<DataUse, Permission>;

/** The permission for each use, from a feed's rights and its licence evidence. */
export function permissionsOf(
  rights: EffectiveRights,
  evidence: LicenseEvidence | null,
): Permissions {
  return permissionsFrom(rights, evidence !== null);
}

/**
 * The permission for each use of data whose licence the instance declares
 * itself, such as its own crowd reports: there is no claim to check.
 */
export function declaredPermissions(rights: EffectiveRights): Permissions {
  return permissionsFrom(rights, true);
}

function permissionsFrom(rights: EffectiveRights, established: boolean): Permissions {
  const of = (grant: boolean | null): Permission =>
    grant === false ? "no" : grant === true && established ? "yes" : "unknown";
  return {
    display: of(rights.display),
    redistribute: of(rights.redistribution),
    derive: of(rights.derivedRedistribution),
    retain: of(rights.retention),
    commercial: of(rights.commercialUse),
  };
}

/** Whether a feed's data is withheld from the public scope: share-alike, or
 *  redistribution not established (denied, unknown, or granted on an unchecked
 *  claim). The public scope passes the source data itself on to anyone. */
export function isRestricted(r: EffectiveRights, evidence: LicenseEvidence | null): boolean {
  return r.shareAlike || permissionsOf(r, evidence).redistribute !== "yes";
}

/** Whether a feed's data may be offered to a catalogue's children: redistribution,
 *  derived redistribution, commercial use and retention must all be granted. */
export function admitsCatalogChild(r: EffectiveRights): boolean {
  return (
    r.redistribution === true &&
    r.derivedRedistribution === true &&
    r.commercialUse === true &&
    r.retention === true
  );
}
