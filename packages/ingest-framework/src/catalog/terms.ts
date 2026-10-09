import { licenseInfo } from "./licenses.js";

/** A feed's own terms, which override its licence field by field. A key that is
 *  set, even to `null`, wins over the licence; an absent or `undefined` key
 *  defers to it. */
export interface FeedTerms {
  url?: string;
  reviewedAt?: string;
  note?: string;
  /** A notice the publisher requires to accompany any display of its data. */
  notice?: string;
  redistribution?: boolean | null;
  derivedRedistribution?: boolean | null;
  commercialUse?: boolean | null;
  attributionRequired?: boolean | null;
  retention?: boolean | null;
}

export interface EffectiveRights {
  redistribution: boolean | null;
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
    redistribution: right("redistribution"),
    derivedRedistribution: right("derivedRedistribution"),
    commercialUse: right("commercialUse"),
    attributionRequired: right("attributionRequired"),
    retention: right("retention"),
    shareAlike: info.shareAlike,
  };
}

/** Whether a feed's data is withheld from the public scope: share-alike, or
 *  redistribution not granted (denied, unknown or unstated). */
export function isRestricted(r: EffectiveRights): boolean {
  return r.shareAlike || r.redistribution !== true;
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
