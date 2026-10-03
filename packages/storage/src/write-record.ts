import type { RevisionedClass } from "@openconditions/core/server";
import {
  computeChangeKinds,
  contentHash,
  historyEligible,
  sealRecord,
  type ValidationIssue,
} from "@openconditions/model";
import type postgres from "postgres";
import { insertRows, type Sql } from "./bulk.js";
import { updateCanonicalView } from "./canonical-view.js";
import { expiryOf } from "./record-rows.js";
import { writeObservationsIn } from "./write-observations.js";
import {
  REVISION_COLUMNS,
  type Rejection,
  refreshExpiries,
  revisionRow,
  storeRecords,
  type WriteContext,
} from "./write-records.js";

type Rec = Record<string, unknown>;

/**
 * One record to write on its own: a `draft` the write seam seals here (a
 * crowd report being landed), or a `stored` record its own instance already
 * sealed (a peer's record being admitted), kept with that instance's
 * revision.
 */
export type RecordInput = { draft: Rec } | { stored: Rec };

export type WriteRecordResult =
  | {
      /**
       * `stale`: a stored record no newer than the one kept. `refreshed`: a
       * stored record at the kept revision with another expiry, which is all
       * that is taken from it — its instance moved the lifetime (a crowd
       * report's evidence) without a new revision. `foreign`: a stored record
       * whose id another instance's record already holds — two instances
       * ingesting one feed mint the same ids, and each keeps its own.
       */
      status: "created" | "updated" | "restored" | "unchanged" | "refreshed" | "stale" | "foreign";
      class: RevisionedClass | "observation";
      id: string;
      revision: number;
    }
  | {
      status: "rejected";
      class: RevisionedClass | "observation" | undefined;
      id: string | undefined;
      issues: readonly ValidationIssue[];
    };

/**
 * Writes one record in its own transaction, under its source's advisory
 * lock: every write to a source's records (a poll, a report, the sweep)
 * holds that lock, so none of them interleave. See {@link writeRecordIn}.
 */
export async function writeRecord(
  sql: postgres.Sql,
  input: RecordInput,
  ctx: Omit<WriteContext, "complete">,
): Promise<WriteRecordResult> {
  const record = "draft" in input ? input.draft : input.stored;
  const sourceId = (record["provenance"] as Rec | undefined)?.["sourceId"];
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${String(sourceId)}))`;
    return writeRecordIn(tx, input, ctx);
  }) as Promise<WriteRecordResult>;
}

/**
 * Writes one record inside the caller's transaction. A draft whose content
 * the stored record already has writes nothing; otherwise it is sealed with
 * the next revision. A stored record is validated as it is and written only
 * when its revision is newer than the stored one, so a peer's late or
 * repeated delivery changes nothing but the expiry, and never over a record
 * another instance wrote. An observation goes to its series.
 */
export async function writeRecordIn(
  tx: Sql,
  input: RecordInput,
  ctx: Omit<WriteContext, "complete">,
): Promise<WriteRecordResult> {
  const record = "draft" in input ? input.draft : input.stored;
  const cls = record["class"] as RevisionedClass | "observation" | undefined;
  const id = typeof record["id"] === "string" ? record["id"] : undefined;
  if (cls !== "situation" && cls !== "feature" && cls !== "offer" && cls !== "observation") {
    return {
      status: "rejected",
      class: undefined,
      id,
      issues: [{ path: ["class"], code: "custom", message: "not a record class" }],
    };
  }
  if (cls === "observation") return writeObservation(tx, input, ctx, id);

  const [existing] = await tx.unsafe<
    {
      content_hash: string;
      revision: number;
      tombstoned: boolean;
      record: Rec;
      expires_at: Date | null;
      instance_id: string;
    }[]
  >(
    `SELECT content_hash, revision, tombstoned_at IS NOT NULL AS tombstoned, record, expires_at,
            instance_id
       FROM conditions.${cls} WHERE id = $1`,
    [id ?? ""],
  );

  let sealed: Rec;
  if ("draft" in input) {
    let hash: string;
    try {
      hash = contentHash(input.draft);
    } catch (err) {
      return reject(cls, id, (err as Error).message);
    }
    if (existing && !existing.tombstoned && existing.content_hash === hash) {
      if (expiryOf(input.draft) !== (existing.expires_at?.getTime() ?? null)) {
        await refreshExpiries(tx, cls, [input.draft]);
      }
      return { status: "unchanged", class: cls, id: id!, revision: existing.revision };
    }
    const result = sealRecord(ctx.registry, input.draft, {
      instanceId: ctx.instanceId,
      revision: (existing?.revision ?? 0) + 1,
      recordedAt: ctx.now,
    });
    if (!result.ok) return { status: "rejected", class: cls, id, issues: result.issues };
    sealed = result.value;
  } else {
    const result = ctx.registry.validate(input.stored);
    if (!result.ok) return { status: "rejected", class: cls, id, issues: result.issues };
    sealed = result.value;
    const instanceId = (sealed["provenance"] as Rec)["instanceId"];
    if (existing && existing.instance_id !== instanceId) {
      return { status: "foreign", class: cls, id: id!, revision: existing.revision };
    }
    if (existing && existing.revision >= (sealed["revision"] as number)) {
      if (
        existing.revision === sealed["revision"] &&
        !existing.tombstoned &&
        expiryOf(sealed) !== expiryOf(existing.record)
      ) {
        await refreshExpiries(tx, cls, [sealed]);
        return { status: "refreshed", class: cls, id: id!, revision: existing.revision };
      }
      return { status: "stale", class: cls, id: id!, revision: existing.revision };
    }
  }

  const status = existing === undefined ? "created" : existing.tombstoned ? "restored" : "updated";
  const changeKinds =
    status === "updated" ? computeChangeKinds(ctx.registry, existing!.record, sealed) : ["created"];
  await storeRecords(tx, cls, [sealed], ctx.registry);
  if (historyEligible(sealed as unknown as Parameters<typeof historyEligible>[0])) {
    await insertRows(tx, `${cls}_revision`, REVISION_COLUMNS(cls), [
      revisionRow(cls, sealed, changeKinds),
    ]);
  }
  if (cls === "feature") {
    await updateCanonicalView(
      tx,
      ctx.registry,
      {
        sourceId: (sealed["provenance"] as Rec)["sourceId"] as string,
        featureIds: [id!],
        observations: [],
      },
      ctx,
    );
  }
  return { status, class: cls, id: id!, revision: sealed["revision"] as number };
}

async function writeObservation(
  tx: Sql,
  input: RecordInput,
  ctx: Omit<WriteContext, "complete">,
  id: string | undefined,
): Promise<WriteRecordResult> {
  const record = "draft" in input ? input.draft : input.stored;
  const rejected: Rejection[] = [];
  const sourceId = (record["provenance"] as Rec | undefined)?.["sourceId"] as string;
  const counts = await writeObservationsIn(
    tx,
    sourceId,
    [record],
    { ...ctx, complete: false },
    rejected,
    "draft" in input ? "draft" : "stored",
  );
  if (rejected.length > 0) {
    return { status: "rejected", class: "observation", id, issues: rejected[0]!.issues };
  }
  await updateCanonicalView(
    tx,
    ctx.registry,
    { sourceId, featureIds: [], observations: [record] },
    ctx,
  );
  const status =
    counts.unchanged > 0
      ? "unchanged"
      : counts.latest > 0 || counts.history > 0
        ? "updated"
        : "stale";
  return { status, class: "observation", id: id!, revision: 1 };
}

function reject(cls: RevisionedClass, id: string | undefined, message: string): WriteRecordResult {
  return { status: "rejected", class: cls, id, issues: [{ path: [], code: "custom", message }] };
}
