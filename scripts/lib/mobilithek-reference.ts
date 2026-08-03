import type { SiteTableReference } from "@openconditions/roads";

export const MOBILITHEK_METADATA_URL = "https://mobilithek.info/mdp-api/mdp-msa-metadata/v2/offers";

export interface MobilithekContentStandard {
  accessURL?: string;
  modified?: string;
  instance?: {
    fileName?: string;
    byteSize?: number;
  };
}

export interface MobilithekOfferMetadata {
  contentStandard?: MobilithekContentStandard[];
}

export interface SiteTableReferenceConfig {
  url: string;
  reference: SiteTableReference;
}

export type MobilithekReferenceStatus = "current" | "stale" | "missing" | "invalid";

export interface MobilithekReferenceCheck {
  status: MobilithekReferenceStatus;
  configuredFileName?: string;
  latestFileName?: string;
  latestModified?: string;
  latestUrl?: string;
  message: string;
}

function fileNameFromUrl(rawUrl: string): string | undefined {
  try {
    const pathname = new URL(rawUrl).pathname;
    const rawName = pathname.slice(pathname.lastIndexOf("/") + 1);
    return rawName ? decodeURIComponent(rawName) : undefined;
  } catch {
    return undefined;
  }
}

function fileNameFromContentStandard(entry: MobilithekContentStandard): string | undefined {
  if (entry.instance?.fileName) return entry.instance.fileName;
  if (entry.accessURL) {
    const rawName = entry.accessURL.slice(entry.accessURL.lastIndexOf("/") + 1);
    return rawName ? decodeURIComponent(rawName) : undefined;
  }
  return undefined;
}

function modifiedTime(value: string | undefined): number {
  if (value == null) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Build the public auxiliary-file URL for any Mobilithek offer. */
export function mobilithekReferenceFileUrl(offerId: string, fileName: string): string {
  return `https://mobilithek.info/mdp-api/files/aux/${encodeURIComponent(offerId)}/${encodeURIComponent(fileName)}`;
}

/** Build the public metadata URL used by the scheduled maintenance check. */
export function mobilithekOfferMetadataUrl(offerId: string): string {
  return `${MOBILITHEK_METADATA_URL}/${encodeURIComponent(offerId)}`;
}

/**
 * Compare an explicitly configured versioned reference URL with the provider's
 * current content-standard list. Only files matching the configured prefix are
 * considered, so an XSD or license attachment cannot become the selected table.
 */
export function checkMobilithekReference(
  siteTable: SiteTableReferenceConfig,
  metadata: MobilithekOfferMetadata
): MobilithekReferenceCheck {
  const configuredFileName = fileNameFromUrl(siteTable.url);
  if (configuredFileName == null) {
    return {
      status: "invalid",
      message: `site-table URL has no usable filename: ${siteTable.url}`,
    };
  }

  const candidates = (metadata.contentStandard ?? [])
    .flatMap((entry) => {
      const fileName = fileNameFromContentStandard(entry);
      return fileName?.startsWith(siteTable.reference.fileNamePrefix)
        ? [{ fileName, modified: entry.modified }]
        : [];
    })
    .sort((a, b) => {
      const byDate = modifiedTime(b.modified) - modifiedTime(a.modified);
      return byDate !== 0 ? byDate : b.fileName.localeCompare(a.fileName);
    });

  const latest = candidates[0];
  if (latest == null) {
    return {
      status: "missing",
      configuredFileName,
      message: `offer ${siteTable.reference.offerId} has no content-standard file matching ${siteTable.reference.fileNamePrefix}*`,
    };
  }

  const latestUrl = mobilithekReferenceFileUrl(siteTable.reference.offerId, latest.fileName);
  if (configuredFileName === latest.fileName) {
    return {
      status: "current",
      configuredFileName,
      latestFileName: latest.fileName,
      ...(latest.modified != null ? { latestModified: latest.modified } : {}),
      latestUrl,
      message: `${configuredFileName} is current`,
    };
  }

  return {
    status: "stale",
    configuredFileName,
    latestFileName: latest.fileName,
    ...(latest.modified != null ? { latestModified: latest.modified } : {}),
    latestUrl,
    message: `${configuredFileName} is older than ${latest.fileName}`,
  };
}

export async function fetchMobilithekOffer(
  offerId: string,
  fetchFn: typeof fetch = fetch
): Promise<MobilithekOfferMetadata> {
  const response = await fetchFn(mobilithekOfferMetadataUrl(offerId));
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching Mobilithek offer ${offerId}`);
  const body: unknown = await response.json();
  if (body == null || typeof body !== "object") {
    throw new Error(`Mobilithek offer ${offerId} returned a non-object metadata response`);
  }
  return body as MobilithekOfferMetadata;
}
