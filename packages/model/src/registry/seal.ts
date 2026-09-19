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
  opts: { instanceId: string; revision: number; recordedAt: string },
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
  sealed["contentHash"] = contentHash(sealed);
  return registry.validate(sealed);
}
