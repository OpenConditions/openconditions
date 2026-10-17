import { resolveInstanceId } from "@openconditions/core/server";
import type { CatalogFeed, ParseOutput, RecordDraft } from "@openconditions/ingest-framework";
import { captureLicensing, resolveAttribution } from "@openconditions/ingest-framework";
import {
  AttributionPublisher,
  type GrantState,
  type Registry,
  type RoutingRights,
} from "@openconditions/model";
import { productionRegistry } from "@openconditions/model-registry";
import type { FlowOutput } from "@openconditions/roads";
import {
  LatestCache,
  type LatestCacheWrite,
  type WriteContext,
  type WriteSummary,
  writeSnapshotIn,
} from "@openconditions/storage";
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

const grantState = (value: boolean | null): GrantState =>
  value === null ? "unknown" : value ? "yes" : "no";

/**
 * A review date or instant as the full UTC instant routing evidence requires
 * (a date alone is its midnight UTC); null when absent or unreadable.
 */
function reviewInstant(value: string | undefined): string | null {
  if (value === undefined) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A feed's rights as records carry them: each grant of its licence and terms,
 * the evidence they rest on (the terms page, else the licence's; the licence
 * id) and when the terms were reviewed.
 */
export function routingRightsOf(
  src: Pick<CatalogFeed, "rights" | "terms" | "license" | "licenseUrl">,
): RoutingRights {
  return {
    source_redistribution: grantState(src.rights.redistribution),
    derived_redistribution: grantState(src.rights.derivedRedistribution),
    commercial_use: grantState(src.rights.commercialUse),
    attribution_required: grantState(src.rights.attributionRequired),
    retention: grantState(src.rights.retention),
    evidence_origin: src.terms?.url ?? src.licenseUrl ?? null,
    evidence_version: src.license,
    reviewed_at: reviewInstant(src.terms?.reviewedAt),
  };
}

/**
 * Stamps the reviewed catalogue onto a draft's attribution at the ingestion
 * boundary: provider, licence, the catalogue child and parent policy it was
 * selected under, and the grants of its rights. A payload never states its
 * own rights; they come from the configuration.
 */
/** MeteoAlarm requires the real national issuing service beside a single-country warning. */
function warningPublisher(
  draft: RecordDraft,
  src: CatalogFeed,
): { name: string; url?: string } | undefined {
  if (src.format !== "meteoalarm") return undefined;
  const cap = (draft["details"] as { cap?: { senderName?: unknown; web?: unknown } } | undefined)
    ?.cap;
  const names =
    typeof cap?.senderName === "string"
      ? [cap.senderName]
      : Array.isArray(cap?.senderName)
        ? cap.senderName.flatMap((entry) => (typeof entry?.text === "string" ? [entry.text] : []))
        : [];
  const actualNames = [...new Set(names.map((value) => value.trim()).filter(Boolean))];
  const joined = AttributionPublisher.safeParse({ name: actualNames.join(" / ") });
  const single = actualNames
    .map((name) => AttributionPublisher.safeParse({ name }))
    .find((value) => value.success);
  // Keep an actual complete localized name, never truncate/invent an issuer.
  // If none fits the portable receipt, the original CAP remains unchanged.
  const publisher = joined.success ? joined.data : single?.success ? single.data : undefined;
  if (!publisher) return undefined;
  const web = typeof cap?.web === "string" ? cap.web : undefined;
  const link =
    web &&
    URL.canParse(web) &&
    ["https:", "http:"].includes(new URL(web).protocol) &&
    !new URL(web).username &&
    !new URL(web).password
      ? web
      : undefined;
  const parsed = AttributionPublisher.safeParse({ ...publisher, ...(link ? { url: link } : {}) });
  return parsed.success ? parsed.data : publisher;
}

export function stampAttribution(
  draft: RecordDraft,
  src: CatalogFeed,
  polledAt?: Date,
): RecordDraft {
  return attributionStamp(src, polledAt)(draft);
}

/**
 * When the data a draft credits was observed: its reading's instant, or the
 * start of its interval; undefined for a draft that states neither.
 */
function observedAt(draft: RecordDraft): Date | undefined {
  const time = draft["phenomenonTime"] as { instant?: unknown; start?: unknown } | undefined;
  const at = time?.instant ?? time?.start;
  if (typeof at !== "string") return undefined;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * {@link stampAttribution} for the drafts of one poll. The catalogue's
 * `{year}` is the UTC year of the draft's reading, else of the poll
 * (`polledAt`, now when unset). Drafts that credit the feed alone share one
 * attribution object per year, so the write validates it once
 * (`Registry.observationDraftValidator`).
 */
export function attributionStamp(
  src: CatalogFeed,
  polledAt: Date = new Date(),
): (draft: RecordDraft) => RecordDraft {
  const policyIds =
    src.policyIds ?? (src.parentSourceId ? [src.parentSourceId, src.id] : undefined);
  const attributionOf = (publisher: { name: string; url?: string } | undefined, at: Date) => ({
    provider: resolveAttribution(src.attribution, at),
    ...(publisher ? { publisher } : {}),
    name: src.name,
    url: src.homepage,
    licensing: captureLicensing(src),
    license: src.license,
    ...(src.licenseUrl ? { licenseUrl: src.licenseUrl } : {}),
    ...(src.parentSourceId ? { parentSourceId: src.parentSourceId, childSourceId: src.id } : {}),
    ...(policyIds && policyIds.length > 0 ? { policyIds } : {}),
    rights: routingRightsOf(src),
  });
  // One per year credited: a poll spans two at most, across New Year.
  const feedAttributions = new Map<number, ReturnType<typeof attributionOf>>();
  return (draft) => {
    const provenance = draft["provenance"] as Record<string, unknown> | undefined;
    if (provenance === undefined) return draft;
    const publisher = warningPublisher(draft, src);
    const at = observedAt(draft) ?? polledAt;
    let feedAttribution = feedAttributions.get(at.getUTCFullYear());
    if (publisher === undefined && feedAttribution === undefined) {
      feedAttribution = attributionOf(undefined, at);
      feedAttributions.set(at.getUTCFullYear(), feedAttribution);
    }
    return {
      ...draft,
      provenance: {
        ...provenance,
        ...(Array.isArray(provenance["upstream"])
          ? {
              upstream: provenance["upstream"].map((raw) => {
                if (!raw || typeof raw !== "object") return raw;
                const upstream = raw as Record<string, unknown>;
                // A source snapshot is already acquired evidence, including an
                // explicit absence of scoped terms. Never fill it from today's registry.
                if (upstream["source"] !== undefined) return upstream;
                return {
                  ...upstream,
                  licensing:
                    upstream["licensing"] ??
                    captureLicensing({
                      id: src.id,
                      name: String(upstream["publisher"] ?? src.name),
                      license: String(upstream["license"] ?? "NOASSERTION"),
                    }),
                };
              }),
            }
          : {}),
        attribution: publisher ? attributionOf(publisher, at) : feedAttribution,
      },
    };
  };
}

/** One poll's identity, as its status and its records name it. */
export interface PollIdentity {
  /** All data inputs were freshly acquired; held-cache replay omits this. */
  captureEvidence?: "acquired";
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
  src: Pick<CatalogFeed, "id" | "freshnessWindowSec">,
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
 * A poll's congestion situations with the start of the ones still under way:
 * a queue a poll derives again began when it was first derived, not at this
 * poll's readings, so it stays one situation instead of taking a revision
 * every poll. One that cleared (its situation withdrawn) starts anew.
 */
async function withOngoingOnsets(
  tx: postgres.TransactionSql,
  sourceId: string,
  situations: readonly RecordDraft[],
): Promise<RecordDraft[]> {
  if (situations.length === 0) return [];
  const ids = situations.map((d) => String(d["id"]));
  const ongoing = new Map(
    (
      await tx<{ id: string; start: string }[]>`
        SELECT id, record -> 'validity' ->> 'start' AS start FROM conditions.situation
         WHERE source_id = ${sourceId} AND tombstoned_at IS NULL AND id = ANY(${ids}::text[])
           AND record -> 'validity' ? 'start'`
    ).map((r) => [r.id, r.start]),
  );
  return situations.map((draft) => {
    const start = ongoing.get(String(draft["id"]));
    const validity = draft["validity"] as { start?: string } | undefined;
    if (start === undefined || validity?.start === undefined) return draft;
    if (Date.parse(start) >= Date.parse(validity.start)) return draft;
    return { ...draft, validity: { ...validity, start } };
  });
}

/**
 * Writes one poll of a flow feed and closes its attempt, in one transaction
 * under the source's lock: its measurement sites, their readings and the
 * congestion situations derived from them. The poll holds every derived
 * situation, so a cleared one is withdrawn, unless `situationsComplete` is
 * false (the poll could not derive any), which keeps the stored ones. It
 * holds only the sites that reported, so a site is never withdrawn for
 * missing one poll (the sweep retires the sites of a source that stopped
 * polling). A poll that `restatesTransient` ends the transient series it no
 * longer restates.
 *
 * The publication counts keep their meaning, records written: a new or
 * restored site or situation is inserted, a changed one or a new reading is
 * updated, a cleared situation deleted; the row count is the source's live
 * sites and situations.
 */
export async function publishFlows(
  sql: Sql,
  src: Pick<CatalogFeed, "id" | "freshnessWindowSec">,
  input: {
    output: FlowOutput;
    /** Whether the poll could derive congestion at all; default true. */
    situationsComplete?: boolean;
    /** The poll restates every transient reading in effect: one it does not restate has ended. */
    restatesTransient?: boolean;
    rejected: number;
    poll: PollIdentity;
    durationMs: number;
    now: string;
    model: WriteModel;
  },
): Promise<{ summary: WriteSummary; counts: PublicationCounts }> {
  const cache = latestCache.begin(src.id);
  const published = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${src.id}))`;
    const { output } = input;
    const summary = await writeSnapshotIn(
      tx,
      src.id,
      {
        situations: await withOngoingOnsets(tx, src.id, output.situations),
        features: output.features,
        observations: output.observations,
      },
      {
        ...writeContext(input),
        complete: { situation: input.situationsComplete ?? true },
        restatesTransient: input.restatesTransient === true,
        latestCache: cache,
      },
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
  return withCache(cache, published);
}

/**
 * Writes one poll of a features feed and closes its attempt, in one
 * transaction under the source's lock: its features, their readings and its
 * offers. The poll is a complete snapshot of features and offers, so a stored
 * one it no longer holds is withdrawn; readings are never withdrawn, a series
 * outliving a missing reading, but when every role's states are in it
 * (`statesComplete`) a polled change-only series it does not state ends. The
 * row count is the source's live features.
 */
export async function publishFeatures(
  sql: Sql,
  src: Pick<CatalogFeed, "id" | "freshnessWindowSec">,
  input: {
    output: Pick<ParseOutput, "features" | "observations" | "offers">;
    rejected: number;
    poll: PollIdentity;
    durationMs: number;
    now: string;
    model: WriteModel;
    /** Shown on the status beside the publication, e.g. a held payload standing in for a failed role. */
    warning?: string;
    /** Every role's states are in the output: a polled series it does not state has ended. */
    statesComplete?: boolean;
  },
): Promise<{ summary: WriteSummary; counts: PublicationCounts }> {
  const cache = latestCache.begin(src.id);
  const published = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${src.id}))`;
    const { output } = input;
    const summary = await writeSnapshotIn(
      tx,
      src.id,
      { features: output.features, observations: output.observations, offers: output.offers },
      {
        ...writeContext(input),
        complete: { feature: true, offer: true },
        statesComplete: input.statesComplete === true,
        latestCache: cache,
      },
    );
    const [{ live }] = await tx<{ live: number }[]>`
      SELECT count(*)::int AS live FROM conditions.feature
       WHERE source_id = ${src.id} AND tombstoned_at IS NULL`;
    const f = summary.counts.feature;
    const o = summary.counts.offer;
    const rejectedReadings = summary.rejected.filter((r) => r.class === "observation").length;
    const readings = output.observations.length - summary.observations.unchanged - rejectedReadings;
    const counts: PublicationCounts = {
      activeEvents: live,
      rowCount: live,
      inserted: f.created + f.restored + o.created + o.restored,
      updated: f.updated + o.updated + Math.max(0, readings),
      deleted: f.withdrawn + o.withdrawn,
      rejected: input.rejected + summary.rejected.length,
    };
    await upsertSourceStatus(tx, src.id, {
      freshnessWindowSec: src.freshnessWindowSec,
      outcome: output.features.length === 0 ? "complete_empty" : "changed",
      attemptAt: input.poll.at,
      networkValidated: true,
      durationMs: input.durationMs,
      attemptId: input.poll.id,
      ...(input.poll.payloadHashes ? { payloadHashes: input.poll.payloadHashes } : {}),
      ...(input.warning ? { error: input.warning } : {}),
      publication: counts,
    });
    return { summary, counts };
  }) as Promise<{ summary: WriteSummary; counts: PublicationCounts }>;
  return withCache(cache, published);
}

/**
 * Writes the readings of a poll that fetched live states alone and closes its
 * attempt, in one transaction under the source's lock. The poll holds no
 * feature and no offer, so none is touched or withdrawn; it is a successful
 * poll of the source all the same. The row count stays the source's live
 * features.
 */
export async function publishReadings(
  sql: Sql,
  src: Pick<CatalogFeed, "id" | "freshnessWindowSec">,
  input: {
    observations: readonly RecordDraft[];
    rejected: number;
    poll: PollIdentity;
    durationMs: number;
    now: string;
    model: WriteModel;
    /** Shown on the status beside the publication, e.g. a held payload standing in for a failed role. */
    warning?: string;
  },
): Promise<{ summary: WriteSummary; counts: PublicationCounts }> {
  const cache = latestCache.begin(src.id);
  const published = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${src.id}))`;
    const summary = await writeSnapshotIn(
      tx,
      src.id,
      { observations: input.observations },
      { ...writeContext(input), complete: false, latestCache: cache },
    );
    const [{ live }] = await tx<{ live: number }[]>`
      SELECT count(*)::int AS live FROM conditions.feature
       WHERE source_id = ${src.id} AND tombstoned_at IS NULL`;
    const rejectedReadings = summary.rejected.filter((r) => r.class === "observation").length;
    const readings = input.observations.length - summary.observations.unchanged - rejectedReadings;
    const counts: PublicationCounts = {
      activeEvents: live,
      rowCount: live,
      inserted: 0,
      updated: Math.max(0, readings),
      deleted: 0,
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
      ...(input.warning ? { error: input.warning } : {}),
      publication: counts,
    });
    return { summary, counts };
  }) as Promise<{ summary: WriteSummary; counts: PublicationCounts }>;
  return withCache(cache, published);
}

/**
 * What this process's polls left in their sources' latest rows: a poll
 * reads no reading back that it shows unchanged. A feed polls in one
 * process; a restart starts it empty. Its budget is a share of this
 * process's heap limit, or `OPENCONDITIONS_LATEST_CACHE_MB`.
 */
const latestCache = new LatestCache();

/** A poll's transaction, the cache taking what it wrote when it commits and forgetting it when not. */
function withCache<T>(cache: LatestCacheWrite, transaction: Promise<T>): Promise<T> {
  return transaction.then(
    (done) => {
      cache.commit();
      return done;
    },
    (err: unknown) => {
      cache.discard();
      throw err;
    },
  );
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
    ...(input.poll.captureEvidence ? { captureEvidence: input.poll.captureEvidence } : {}),
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
