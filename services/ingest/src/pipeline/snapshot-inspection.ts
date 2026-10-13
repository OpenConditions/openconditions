import { parseXmlDocument } from "@openconditions/datex2";
import type { CatalogFeed } from "@openconditions/ingest-framework";

/**
 * What a complete-snapshot feed's payload says about itself: whether the
 * feed declares a snapshot contract, how many records it holds, and whether
 * it is a complete snapshot of none.
 */
export interface SnapshotInspection {
  complete: boolean;
  inputRecords?: number;
  completeEmpty: boolean;
}

function valueAtPath(value: unknown, path: string): unknown {
  if (path === "$" || path === "") return value;
  let current = value;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function countXmlRecordElements(value: unknown, element: string): number {
  if (Array.isArray(value)) {
    return value.reduce((count, child) => count + countXmlRecordElements(child, element), 0);
  }
  if (value == null || typeof value !== "object") return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === element) count += Array.isArray(child) ? child.length : 1;
    else count += countXmlRecordElements(child, element);
  }
  return count;
}

function findXmlElements(value: unknown, element: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((child) => findXmlElements(child, element));
  if (value == null || typeof value !== "object") return [];
  const matches: unknown[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === element) matches.push(...(Array.isArray(child) ? child : [child]));
    matches.push(...findXmlElements(child, element));
  }
  return matches;
}

function xmlPublicationType(value: unknown): string | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)["@_type"];
  if (typeof raw !== "string") return undefined;
  return raw.slice(raw.lastIndexOf(":") + 1);
}

export function inspectSnapshotCompleteness(
  src: Pick<CatalogFeed, "snapshot">,
  buffers: readonly Buffer[],
): SnapshotInspection {
  const contract = src.snapshot;
  if (!contract) return { complete: false, completeEmpty: false };
  if (contract.recordElement) {
    let inputRecords = 0;
    for (const buffer of buffers) {
      const document = parseXmlDocument(buffer, {
        removeNSPrefix: true,
        validate: true,
        isArray: () => false,
      });
      const roots = findXmlElements(document, contract.rootElement!);
      if (roots.length === 0) {
        throw new Error(`snapshot completeness: expected XML ${contract.rootElement} element`);
      }
      // DATEX II v3 has no wrapper: the root element is the publication.
      const candidates =
        contract.publicationElement === contract.rootElement
          ? roots
          : roots.flatMap((root) => findXmlElements(root, contract.publicationElement!));
      const publications = candidates.filter(
        (publication) => xmlPublicationType(publication) === contract.publicationType,
      );
      if (publications.length === 0) {
        throw new Error(
          `snapshot completeness: expected ${contract.publicationType} ${contract.publicationElement}`,
        );
      }
      for (const publication of publications) {
        inputRecords += countXmlRecordElements(publication, contract.recordElement);
      }
    }
    return { complete: true, inputRecords, completeEmpty: inputRecords === 0 };
  }
  if (!contract.recordsPath) return { complete: true, completeEmpty: buffers.length === 0 };

  let inputRecords = 0;
  let declaredTotal: number | undefined;
  for (const buffer of buffers) {
    let document: unknown;
    try {
      document = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new Error(
        `snapshot completeness: ${contract.recordsPath} cannot be read from invalid JSON`,
      );
    }
    const records = valueAtPath(document, contract.recordsPath);
    if (!Array.isArray(records)) {
      throw new Error(`snapshot completeness: ${contract.recordsPath} must be an array`);
    }
    inputRecords += records.length;
    if (contract.totalCountPath) {
      const total = valueAtPath(document, contract.totalCountPath);
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
        throw new Error(
          `snapshot completeness: ${contract.totalCountPath} must be a non-negative integer`,
        );
      }
      declaredTotal ??= total;
      if (declaredTotal !== total)
        throw new Error("snapshot completeness: inconsistent declared totals");
    }
  }
  if (declaredTotal != null && declaredTotal !== inputRecords) {
    throw new Error(
      `snapshot completeness: source declared ${declaredTotal} records but retrieved ${inputRecords}`,
    );
  }
  return { complete: true, inputRecords, completeEmpty: inputRecords === 0 };
}
