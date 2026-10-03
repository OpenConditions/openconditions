import type { FeedEndpoint, FetchFn } from "@openconditions/ingest-framework";

/** A reference endpoint: a file Mobilithek publishes beside one of its offers. */
export type MobilithekReference = NonNullable<FeedEndpoint["reference"]>;

const METADATA_URL = "https://mobilithek.info/mdp-api/mdp-msa-metadata/v2/offers";

/** One content-standard file of an offer, as the metadata lists it. */
interface ContentStandard {
  accessURL?: string;
  modified?: string;
  instance?: { fileName?: string };
}

/** The public metadata of one Mobilithek offer. */
export function mobilithekOfferMetadataUrl(offerId: string): string {
  return `${METADATA_URL}/${encodeURIComponent(offerId)}`;
}

/** The public auxiliary-file URL of one file of an offer. */
export function mobilithekReferenceFileUrl(offerId: string, fileName: string): string {
  return `https://mobilithek.info/mdp-api/files/aux/${encodeURIComponent(offerId)}/${encodeURIComponent(fileName)}`;
}

function fileNameOf(entry: ContentStandard): string | undefined {
  if (entry.instance?.fileName) return entry.instance.fileName;
  if (!entry.accessURL) return undefined;
  const name = entry.accessURL.slice(entry.accessURL.lastIndexOf("/") + 1);
  return name ? decodeURIComponent(name) : undefined;
}

function modifiedTime(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * The URL of the latest file of a Mobilithek offer whose name starts with the
 * reference's prefix: newest `modified` first, then the greatest name (the
 * versioned names count up). Only prefixed files are candidates, so a schema
 * or licence attachment of the same offer is never chosen. Reads the offer's
 * public metadata through `fetchFn`; throws on a failed request or when no
 * file matches.
 */
export async function resolveMobilithekReference(
  reference: MobilithekReference,
  fetchFn: FetchFn,
): Promise<string> {
  const res = await fetchFn(mobilithekOfferMetadataUrl(reference.offerId));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching Mobilithek offer ${reference.offerId}`);
  }
  const body: unknown = await res.json();
  const entries =
    body !== null && typeof body === "object"
      ? (body as { contentStandard?: unknown }).contentStandard
      : undefined;
  const latest = (Array.isArray(entries) ? (entries as ContentStandard[]) : [])
    .flatMap((entry) => {
      const fileName = fileNameOf(entry);
      return fileName?.startsWith(reference.fileNamePrefix)
        ? [{ fileName, modified: modifiedTime(entry.modified) }]
        : [];
    })
    .sort((a, b) => b.modified - a.modified || b.fileName.localeCompare(a.fileName))[0];
  if (!latest) {
    throw new Error(
      `Mobilithek offer ${reference.offerId} has no file matching ${reference.fileNamePrefix}*`,
    );
  }
  return mobilithekReferenceFileUrl(reference.offerId, latest.fileName);
}
