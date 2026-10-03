import { resolveInstanceId } from "@openconditions/core/server";
import type { RecordDraft } from "@openconditions/ingest-framework";
import type { Registry } from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type { FeedSource, FlowOutput } from "@openconditions/roads";
import { type WriteContext, type WriteSummary, writeSnapshotIn } from "@openconditions/storage";
import type postgres from "postgres";
import { upsertSourceStatus } from "./source-status.js";

type Sql = postgres.Sql;

/** The model a poll seals its records against, and the instance it writes as. */
export interface WriteModel {
  registry: Registry;
  instanceId: string;
}

let defaultRegistry: Registry | undefined;

/** The production registry and this instance's id, unless the caller supplies its own. */
export function writeModel(over: Partial<WriteModel> = {}): WriteModel {
  defaultRegistry ??= productionRegistry();
  return {
    registry: over.registry ?? defaultRegistry,
    instanceId: over.instanceId ?? resolveInstanceId(),
  };
}

const grantState = (value: boolean | null | undefined): "yes" | "no" | "unknown" =>
  value == null ? "unknown" : value ? "yes" : "no";

/**
 * Stamps the reviewed catalogue onto a draft's attribution at the ingestion
 * boundary: provider, licence, the catalogue child and parent policy it was
 * selected under, and the grants of its rights review. A payload never states
 * its own rights; they come from the configuration.
 */
export function stampAttribution(draft: RecordDraft, src: FeedSource): RecordDraft {
  const provenance = draft["provenance"] as Record<string, unknown> | undefined;
  if (provenance === undefined) return draft;
  const policyIds =
    src.policyIds ?? (src.parentSourceId ? [src.parentSourceId, src.id] : undefined);
  return {
    ...draft,
    provenance: {
      ...provenance,
      attribution: {
        provider: src.attribution,
        license: src.license,
        ...(src.licenseUrl ? { licenseUrl: src.licenseUrl } : {}),
        ...(src.parentSourceId
          ? { parentSourceId: src.parentSourceId, childSourceId: src.id }
          : {}),
        ...(policyIds && policyIds.length > 0 ? { policyIds } : {}),
        rights: {
          source_redistribution: grantState(src.rights?.sourceRedistribution),
          derived_redistribution: grantState(src.rights?.derivedRedistribution),
          commercial_use: grantState(src.rights?.commercialUse),
          attribution_required: grantState(src.rights?.attributionRequired),
          retention: grantState(src.rights?.retention),
          evidence_origin: src.rights?.evidenceOrigin ?? null,
          evidence_version: src.rights?.evidenceVersion ?? null,
          reviewed_at: src.rights?.reviewedAt ?? null,
        },
      },
    },
  };
}

/** One poll's identity, as its status and its records name it. */
export interface PollIdentity {
  /** When the poll started. */
  at: string;
  /** The poll attempt row, closed by the publication; also the raw payloads' fetch id. */
  id: number;
  payloadHashes?: readonly string[];
}

/** Situation ids still published upstream that this poll could not place. */
export class UnlocatableRetainedError extends Error {}

/**
 * Writes one poll's situations of an event feed and closes its attempt, in
 * one transaction under the source's lock, so the records, their revisions,
 * their binding work and the source status commit together. The snapshot is
 * complete: a stored situation it no longer holds is withdrawn, except that a
 * situation still published but unplaceable this poll (`unlocatable`) is never
 * ended or stripped of an unplaceable record's effects by it — such a poll
 * fails as a whole instead, keeping the last good publication. A draft that
 * does not validate is rejected and counted; a poll holding more situations
 * than a source may publish is refused whole.
 */
export async function publishSituations(
  sql: Sql,
  src: FeedSource,
  input: {
    situations: readonly RecordDraft[];
    unlocatable?: readonly string[];
    /** Local ids of the records behind `unlocatable`; a stored effect's id begins with its record's. */
    unlocatableRecords?: readonly string[];
    rejected: number;
    poll: PollIdentity;
    durationMs: number;
    now: string;
    model: WriteModel;
  },
): Promise<WriteSummary> {
  const situations = input.situations;
  const ids = situations.map((d) => String(d["id"]));
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${src.id}))`;
    const unlocatable = input.unlocatable ?? [];
    const records = input.unlocatableRecords ?? [];
    // A stored situation is kept when this poll drops it whole, or when it
    // holds an effect of a record that could not be placed: that effect is in
    // no draft, whichever situation of the source a group folded it into.
    const [retained] = await tx<{ id: string }[]>`
      SELECT s.id FROM conditions.situation s
       WHERE s.source_id = ${src.id} AND s.tombstoned_at IS NULL
         AND ((s.id = ANY(${unlocatable}::text[]) AND NOT s.id = ANY(${ids}::text[]))
           OR EXISTS (
             SELECT 1 FROM conditions.situation_effect e, unnest(${records}::text[]) AS r(id)
              WHERE e.situation_id = s.id AND left(e.effect_id, length(r.id) + 1) = r.id || '/'))
       LIMIT 1`;
    if (retained) {
      throw new UnlocatableRetainedError(
        `snapshot unlocatable retained record: ${retained.id} ` +
          `(${unlocatable.length} unlocatable in source ${src.id})`,
      );
    }
    const summary = await writeSnapshotIn(tx, src.id, { situations }, writeContext(input));
    const [{ live }] = await tx<{ live: number }[]>`
      SELECT count(*)::int AS live FROM conditions.situation
       WHERE source_id = ${src.id} AND tombstoned_at IS NULL`;
    const counts = summary.counts.situation;
    await upsertSourceStatus(tx, src.id, {
      freshnessWindowSec: src.freshnessWindowSec,
      outcome: situations.length === 0 ? "complete_empty" : "changed",
      attemptAt: input.poll.at,
      networkValidated: true,
      durationMs: input.durationMs,
      attemptId: input.poll.id,
      ...(input.poll.payloadHashes ? { payloadHashes: input.poll.payloadHashes } : {}),
      publication: {
        activeEvents: live,
        rowCount: live,
        inserted: counts.created + counts.restored,
        updated: counts.updated,
        deleted: counts.withdrawn,
        rejected: input.rejected + summary.rejected.length,
      },
    });
    return summary;
  }) as Promise<WriteSummary>;
}

/**
 * Writes one poll of a flow feed and closes its attempt, in one transaction
 * under the source's lock: its measurement sites, their readings and the
 * congestion situations derived from them. The poll holds every derived
 * situation, so a cleared one is withdrawn; it holds only the sites that
 * reported, so a site is never withdrawn for missing one poll (the sweep
 * retires the sites of a source that stopped polling).
 *
 * The publication counts keep their meaning, records written: a new or
 * restored site or situation is inserted, a changed one or a new reading is
 * updated, a cleared situation deleted; the row count is the source's live
 * sites and situations.
 */
export async function publishFlows(
  sql: Sql,
  src: FeedSource,
  input: {
    output: FlowOutput;
    rejected: number;
    poll: PollIdentity;
    durationMs: number;
    now: string;
    model: WriteModel;
  },
): Promise<{ summary: WriteSummary; counts: PublicationCounts }> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${src.id}))`;
    const { output } = input;
    const summary = await writeSnapshotIn(
      tx,
      src.id,
      {
        situations: output.situations,
        features: output.features,
        observations: output.observations,
      },
      { ...writeContext(input), complete: { situation: true } },
    );
    const [live] = await tx<{ features: number; situations: number }[]>`
      SELECT (SELECT count(*)::int FROM conditions.feature
               WHERE source_id = ${src.id} AND tombstoned_at IS NULL) AS features,
             (SELECT count(*)::int FROM conditions.situation
               WHERE source_id = ${src.id} AND tombstoned_at IS NULL) AS situations`;
    const f = summary.counts.feature;
    const s = summary.counts.situation;
    const rejectedReadings = summary.rejected.filter((r) => r.class === "observation").length;
    const readings = output.observations.length - summary.observations.unchanged - rejectedReadings;
    const counts: PublicationCounts = {
      activeEvents: live!.situations,
      rowCount: live!.features + live!.situations,
      inserted: f.created + f.restored + s.created + s.restored,
      updated: f.updated + s.updated + Math.max(0, readings),
      deleted: s.withdrawn,
      rejected: input.rejected + summary.rejected.length,
    };
    await upsertSourceStatus(tx, src.id, {
      freshnessWindowSec: src.freshnessWindowSec,
      outcome: "changed",
      attemptAt: input.poll.at,
      networkValidated: true,
      durationMs: input.durationMs,
      attemptId: input.poll.id,
      ...(input.poll.payloadHashes ? { payloadHashes: input.poll.payloadHashes } : {}),
      publication: counts,
    });
    return { summary, counts };
  }) as Promise<{ summary: WriteSummary; counts: PublicationCounts }>;
}

/** What a poll's publication reports on its source's status. */
export interface PublicationCounts {
  activeEvents: number;
  rowCount: number;
  inserted: number;
  updated: number;
  deleted: number;
  rejected: number;
}

/** The write context of a poll's complete snapshot. */
export function writeContext(input: {
  poll: PollIdentity;
  now: string;
  model: WriteModel;
}): WriteContext {
  return {
    registry: input.model.registry,
    instanceId: input.model.instanceId,
    now: input.now,
    complete: true,
    fetchId: input.poll.id,
    ...(input.poll.payloadHashes ? { payloadHashes: input.poll.payloadHashes } : {}),
  };
}

/** The situations a write changed: what the binder has to place again. */
export function changedSituations(summary: WriteSummary): string[] {
  return summary.changed.filter((c) => c.class === "situation").map((c) => c.id);
}

/** Logs the drafts a write rejected, with their first issues, so a parser defect is visible. */
export function logRejections(sourceId: string, summary: WriteSummary): void {
  for (const r of summary.rejected.slice(0, 5)) {
    console.warn(
      `[ingest] ${sourceId}: rejected ${r.class} ${r.id ?? "(no id)"}: ` +
        r.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
    );
  }
  if (summary.rejected.length > 5) {
    console.warn(`[ingest] ${sourceId}: … and ${summary.rejected.length - 5} more rejected`);
  }
}
