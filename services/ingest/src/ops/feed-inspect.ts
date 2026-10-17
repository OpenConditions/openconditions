import { createHash } from "node:crypto";
import type { CatalogFeed, EgressRecord } from "@openconditions/ingest-framework";
import { publicRecords, resolveAttribution } from "@openconditions/ingest-framework";
import { sealRecord } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import {
  datexRecordsOf,
  type ExportDiagnostic,
  effectStatesAt,
  situationsToDatex,
  situationsToGeoJSON,
  situationsToTraff,
} from "@openconditions/publishers";
import { z } from "zod";
import { formatOf } from "../domains.js";
import { parseMainPayloads } from "../pipeline/parse.js";
import { stampAttribution } from "../pipeline/publish.js";
import { inspectSnapshotCompleteness } from "../pipeline/snapshot-inspection.js";

type Rec = Record<string, unknown>;
export const MAX_INSPECT_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100;
const registry = productionRegistry();

/** Shared main-role parse, with the same completeness and input checks in both modes. */
function parseSample(feed: CatalogFeed, buffers: readonly Buffer[], at: string) {
  if (formatOf(feed).kind !== "situations")
    throw new Error("inspection covers situation feeds only");
  if (!z.iso.datetime({ offset: true }).safeParse(at).success) {
    throw new Error("--at must be an ISO timestamp with an explicit UTC offset");
  }
  if (buffers.length === 0) throw new Error("at least one payload is required");
  if (buffers.reduce((bytes, buffer) => bytes + buffer.length, 0) > MAX_INSPECT_BYTES) {
    throw new Error("captured payloads exceed the 32 MiB inspection limit");
  }
  const timestamp = new Date(at).toISOString();
  const snapshot = inspectSnapshotCompleteness(feed, buffers);
  const parsed = parseMainPayloads(feed, buffers, timestamp);
  return { parsed, snapshot, timestamp };
}

/** Discover parser IDs without sealing drafts or projecting exports. */
export function indexFeed(feed: CatalogFeed, buffers: readonly Buffer[], at: string) {
  const { parsed, snapshot, timestamp } = parseSample(feed, buffers, at);
  if (parsed.situations.length > 20_000)
    throw new Error("inspection index exceeds 20,000 situations; use a smaller permitted sample");
  return {
    schemaVersion: 1,
    mode: "index",
    source: { id: feed.id, domain: feed.domain, format: feed.format },
    at: timestamp,
    inputs: inputInfo(buffers),
    snapshot,
    accounting: parsed.records ?? null,
    truncatedBySource: parsed.truncated ?? false,
    warnings: parsed.situations.length === 0 ? ["empty_parse_is_not_proof_of_empty_source"] : [],
    limitations: [
      "Local diagnostic material: parser IDs/headlines only, not validated records. Source text may be non-public; review contents and rights before sharing.",
      "Main-role payloads only; no acquisition, reference data, resolution, binding, database access or exports.",
    ],
    records: parsed.situations.map((draft) => ({
      id: draft["id"],
      kind: draft["kind"],
      headline: draft["headline"],
    })),
  };
}

function inputInfo(buffers: readonly Buffer[]) {
  return buffers.map((buffer) => ({
    sha256: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer.length,
  }));
}

/**
 * A local parser/publisher probe, not an ingestion or database-state simulator.
 * Never fetches, resolves, binds or writes. The canonical preview uses exactly
 * the writer's attribution and validation seams, with explicit synthetic stamps.
 */
export function inspectFeed(
  feed: CatalogFeed,
  buffers: readonly Buffer[],
  at: string,
  opts: { id?: string } = {},
) {
  const { parsed, snapshot, timestamp } = parseSample(feed, buffers, at);
  const instant = new Date(timestamp);
  const selected =
    opts.id === undefined
      ? parsed.situations
      : parsed.situations.filter((d) => d["id"] === opts.id);
  if (opts.id !== undefined && selected.length === 0)
    throw new Error(
      `record ${opts.id} not found among ${parsed.situations.length} parsed situations`,
    );
  if (selected.length > MAX_RECORDS) {
    throw new Error(
      `${selected.length} situations exceed the ${MAX_RECORDS}-record inspection limit; select --id (for example ${String(selected[0]?.["id"])})`,
    );
  }
  const publicSituations: Rec[] = [];
  const records = selected.map((draft) => {
    const stamped = stampAttribution(draft, feed, instant);
    const sealed = sealRecord(registry, stamped, {
      instanceId: "inspect.local",
      revision: 1,
      recordedAt: timestamp,
    });
    if (!sealed.ok) {
      return {
        draft,
        validation: sealed,
        canonicalPreview: null,
        effectStates: null,
        projection: {
          public: { eligible: false, reason: "invalid_draft" },
          traff: { messages: 0, reason: "invalid_draft", diagnostics: [] as ExportDiagnostic[] },
          datex: { records: 0, reason: "invalid_draft", diagnostics: [] as ExportDiagnostic[] },
        },
      };
    }
    const canonicalPreview = sealed.value;
    const shown = feed.restricted
      ? undefined
      : (publicRecords([canonicalPreview as unknown as EgressRecord])[0] as unknown as
          | Rec
          | undefined);
    const reason = feed.restricted
      ? "restricted_source"
      : shown === undefined
        ? "non_public_license"
        : null;
    const traffDiagnostics: ExportDiagnostic[] = [];
    const datexDiagnostics: ExportDiagnostic[] = [];
    const traff = shown
      ? situationsToTraff(registry, [shown], instant, (d) => traffDiagnostics.push(d))
      : "";
    // Count the actual emitter's messages, including own-location effects.
    // XMLBuilder always emits this unprefixed element; attributes may contain
    // escaped text, never a literal '<message'. No independent eligibility gate.
    const messages = (traff.match(/<message(?:\s|>)/g) ?? []).length;
    const datexCount = shown
      ? datexRecordsOf(shown, instant, (d) => datexDiagnostics.push(d)).length
      : 0;
    if (shown) publicSituations.push(shown);
    return {
      draft,
      validation: { ok: true as const },
      canonicalPreview,
      effectStates: effectStatesAt(canonicalPreview, instant),
      projection: {
        public: { eligible: shown !== undefined, reason },
        traff: {
          messages,
          reason:
            reason ??
            (messages === 0
              ? (traffDiagnostics.find((d) => d.disposition === "withheld")?.code ??
                "no_representable_message")
              : null),
          diagnostics: traffDiagnostics,
        },
        datex: {
          records: datexCount,
          reason:
            reason ??
            (datexCount === 0
              ? (datexDiagnostics.find((d) => d.disposition === "withheld")?.code ??
                "no_representable_message")
              : null),
          diagnostics: datexDiagnostics,
        },
      },
    };
  });
  const info = {
    attribution: resolveAttribution(feed.attribution, instant),
    license: feed.license,
    timestamp,
  };
  return {
    schemaVersion: 2,
    mode: "preview",
    source: { id: feed.id, domain: feed.domain, format: feed.format },
    at: timestamp,
    inputs: inputInfo(buffers),
    limitations: [
      "Local diagnostic data: drafts and canonical previews may contain non-public source material. Do not publish this report without reviewing its rights and contents.",
      "Main-role situation payloads only; no reference data, acquisition, OpenLR resolution, graph binding, fusion, database history or lifecycle reconciliation.",
      "Canonical previews use synthetic inspect.local, revision 1 and recordedAt=at. Successful validation does not prove an actual database write would succeed.",
      "Exports cover only selected, valid, public-eligible previews. No API validity, expiry, bbox or deduplication query was applied; XML projection may omit events or reduce geometry. Inspect the actual output.",
    ],
    counts: {
      parsed: parsed.situations.length,
      selected: selected.length,
      valid: records.filter((r) => r.validation.ok).length,
      publicEligible: publicSituations.length,
      rejectedByParser: parsed.rejected ?? 0,
    },
    snapshot,
    warnings: parsed.situations.length === 0 ? ["empty_parse_is_not_proof_of_empty_source"] : [],
    accounting: parsed.records ?? null,
    truncatedBySource: parsed.truncated ?? false,
    records,
    exports: {
      geojson: situationsToGeoJSON(publicSituations, info, { at: instant }),
      traff: situationsToTraff(registry, publicSituations, instant),
      datex: situationsToDatex(
        publicSituations,
        instant,
        info,
        feed.country?.toLowerCase() ?? "zz",
      ),
    },
  };
}
