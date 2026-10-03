import { contentHash } from "../content-hash.js";
import { canonicalIdOf, parseRecordId } from "../kernel/identity.js";
import type { Registry, ValidationResult } from "./build.js";

/**
 * The write seam: validates a parser draft, stamps the derived fields
 * (canonicalId, domain, provenance.instanceId, contentHash) and the storage
 * fields the caller assigns (revision, recordedAt), and validates the result
 * as a stored record.
 */
export function sealRecord(
  registry: Registry,
  draft: unknown,
  opts: {
    instanceId: string;
    revision: number;
    recordedAt: string;
    /**
     * The draft's content hash, when the caller has it: sealing adds only
     * derived fields, so it is the sealed record's too, and a writer that
     * compared it with the stored one need not compute it twice.
     */
    contentHash?: string;
  },
): ValidationResult {
  const checked = registry.validateDraft(draft);
  if (!checked.ok) return checked;
  const rec = checked.value;
  const parts = parseRecordId(rec["id"] as string)!;
  const cls = rec["class"] as "feature" | "situation" | "observation" | "offer";
  const domain =
    cls === "observation"
      ? registry.property(rec["property"] as string)!.domain
      : registry.kind(cls, rec["kind"] as string)!.domain!;
  const provenance = {
    ...(rec["provenance"] as Record<string, unknown>),
    instanceId: opts.instanceId,
  };
  const sealed: Record<string, unknown> = {
    ...rec,
    provenance,
    canonicalId: canonicalIdOf(parts.namespace, parts.localId),
    domain,
    revision: opts.revision,
    recordedAt: opts.recordedAt,
  };
  sealed["contentHash"] = opts.contentHash ?? contentHash(sealed);
  // The draft is valid and sealing adds only derived fields this function
  // computes, so the result is a valid stored record without a second pass
  // (the golden suites check that validating a sealed record changes
  // nothing). A flow poll seals a hundred thousand readings a minute.
  return { ok: true, value: sealed };
}
