import type { RevisionedClass } from "@openconditions/core/server";
import type postgres from "postgres";
import type { Sql } from "./bulk.js";

export interface FederationReconcileOptions {
  /** Records (or series) scanned per transaction; default 500. */
  batchSize?: number;
  /** Stops the reconcile before its next batch. */
  signal?: AbortSignal;
  /** Called once the sources to reconcile are listed. */
  onStart?: (plan: { sources: string[] }) => void;
  /** Called after each committed batch, with the entries journalled so far. */
  onBatch?: (progress: { source: string; journalled: number }) => void;
}

export interface FederationReconcileCounts {
  /** The sources whose flag differed from the one the outbox reflects, in id order. */
  sources: string[];
  /** Outbox entries journalled. */
  journalled: number;
  /** Of the sources, the ones the outbox now reflects, in id order. */
  settled: string[];
}

const RECORD_CLASSES: readonly RevisionedClass[] = ["feature", "situation", "offer"];

/** The class's latest journal entry of record `r`, as `last.operation`. */
const lastEntry = (cls: string, id: string) => `
  LEFT JOIN LATERAL (
    SELECT o.operation FROM conditions.federation_outbox o
     WHERE o.record_class = '${cls}' AND o.record_id = ${id}
     ORDER BY o.seq DESC LIMIT 1) last ON true`;

/**
 * Journals a delete for each record of the page a peer may hold
 * (`federation_was_shared`, the rule an erasure's capture applies too) and
 * not yet retracted: its latest entry is a change, or it has none while a
 * subscription wants the class and it was stored by the time its source
 * turned restricted (its entries may have been pruned). A record stored
 * since, by a poll before or during the reconcile, is never journalled. An
 * ended record's delete carries its own reason; a live one's is
 * `withdrawn`. An erasure removes the record's earlier changes, as its
 * capture does.
 */
async function retract(tx: Sql, cls: RevisionedClass, ids: readonly string[]): Promise<number> {
  const [row] = await tx.unsafe<{ n: number }[]>(
    `WITH due AS (
       SELECT r.id, r.canonical_id, r.kind, r.domain,
              COALESCE(r.tombstone_reason, 'withdrawn') AS reason
         FROM conditions.${cls} r ${lastEntry(cls, "r.id")}
        WHERE r.id = ANY($1::text[])
          AND conditions.federation_is_own(r.record, r.access_mode)
          AND last.operation IS DISTINCT FROM 'delete'
          AND conditions.federation_was_shared('${cls}', r.id, r.created_at, r.source_id)
     ), journalled AS (
       INSERT INTO conditions.federation_outbox
         (operation, record_class, record_id, canonical_id, kind, domain, tombstone_reason)
       SELECT 'delete', '${cls}', id, canonical_id, kind, domain, reason FROM due
       RETURNING record_id, tombstone_reason
     ), erased AS (
       DELETE FROM conditions.federation_outbox o USING journalled j
        WHERE j.tombstone_reason = 'rights_revoked' AND o.record_class = '${cls}'
          AND o.record_id = j.record_id AND o.operation <> 'delete'
     )
     SELECT count(*)::int AS n FROM journalled`,
    [ids as string[]],
  );
  return row?.n ?? 0;
}

/**
 * Journals a create for each live record of the page the outbox may carry,
 * as the capture writes it, while a subscription wants the class, unless its
 * latest entry is already a change (journalled since the flip, or by an
 * earlier run).
 */
async function publish(tx: Sql, cls: RevisionedClass, ids: readonly string[]): Promise<number> {
  const situation = cls === "situation";
  const rows = await tx.unsafe(
    `INSERT INTO conditions.federation_outbox
       (operation, record_class, record_id, canonical_id, kind, domain, priority, snapshot)
     SELECT 'create', '${cls}', r.id, r.canonical_id, r.kind, r.domain,
            ${situation ? "conditions.federation_situation_priority(r.kind, r.record)" : "false"},
            ${situation ? "conditions.federation_situation_snapshot(r)" : "r.record"}
       FROM conditions.${cls} r ${lastEntry(cls, "r.id")}
      WHERE r.id = ANY($1::text[])
        AND r.tombstoned_at IS NULL
        AND conditions.federation_may_carry(r.record, r.access_mode, r.source_id)
        AND conditions.federation_wants('${cls}')
        AND (last.operation IS NULL OR last.operation = 'delete')
     RETURNING record_id`,
    [ids as string[]],
  );
  return rows.length;
}

/**
 * Journals a create of each series' current reading the outbox may carry,
 * as the capture writes it, for a subscription naming its property. An
 * expired reading is left out: it states nothing current.
 */
async function publishReadings(tx: Sql, seriesIds: readonly number[]): Promise<number> {
  const rows = await tx`
    INSERT INTO conditions.federation_outbox
      (operation, record_class, record_id, canonical_id, kind, domain, property, snapshot)
    SELECT 'create', 'observation', x.rec ->> 'id', x.rec ->> 'canonicalId', 'observation',
           x.rec ->> 'domain', x.property, x.rec
      FROM (SELECT l.property, conditions.observation_record(l.template, l.reading) AS rec
              FROM conditions.observation_latest l
             WHERE l.series_id = ANY(${seriesIds as number[]}::bigint[])
               AND l.source_id NOT IN ('@fused', '@fused-public', 'crowd')
               AND (l.expires_at IS NULL OR l.expires_at > now())
               AND EXISTS (
                 SELECT 1 FROM conditions.federation_subscription s
                  WHERE s.filter -> 'properties' ? l.property
                    AND (NOT (s.filter ? 'classes') OR s.filter -> 'classes' ? 'observation'))
               AND conditions.federation_may_carry(l.template, l.access_mode, l.source_id)) x
      LEFT JOIN LATERAL (
        SELECT o.operation FROM conditions.federation_outbox o
         WHERE o.record_class = 'observation' AND o.record_id = x.rec ->> 'id'
         ORDER BY o.seq DESC LIMIT 1) last ON true
     WHERE last.operation IS NULL OR last.operation = 'delete'
    RETURNING record_id`;
  return rows.length;
}

/**
 * Brings the federation outbox up to each source's current `restricted`
 * flag. A source is reconciled when its flag differs from the one the
 * outbox reflects (`federation_restricted`), because a catalogue sync
 * flipped it or an earlier reconcile did not finish, or when an earlier
 * reconcile journalled part of its records (`federation_pending`): even if a
 * flip back since made the basis match the flag again, those records are
 * brought to the flag. Toward the flag:
 *  - turned restricted, a delete is journalled for each record a peer may
 *    hold, so subscribers end their copies. A reading has none: subscribers
 *    keep no tombstone of an observation, and the outbox withholds a
 *    restricted source's earlier changes (`readOutbox`);
 *  - turned public, a create is journalled for each live record and each
 *    series' current reading, as the capture would have written them.
 * An on-demand answer or a peer's record is never journalled, either way,
 * nor anything while no subscription wants it. A source with no basis yet
 * was added since the basis was introduced, so it has nothing journalled to
 * correct: it settles under its flag at once.
 *
 * Each source's records are journalled one page per transaction, under the
 * source's advisory lock, so no poll's capture interleaves with a page. The
 * first page marks the source pending; the transaction of its last page
 * records its basis and clears the mark. A reconcile stopped or failed
 * part-way resumes at the next call: a record whose latest entry already
 * says what the flag asks is skipped, and a settled source is not listed
 * again. The flag is the one read at the listing: a sync in between leaves
 * the source to reconcile again.
 */
export async function reconcileFederation(
  sql: postgres.Sql,
  opts: FederationReconcileOptions = {},
): Promise<FederationReconcileCounts> {
  const counts: FederationReconcileCounts = { sources: [], journalled: 0, settled: [] };
  const flips = await sql<
    { id: string; restricted: boolean; basis: boolean | null; pending: boolean }[]
  >`
    SELECT id, restricted, federation_restricted AS basis, federation_pending AS pending
      FROM conditions.source
     WHERE federation_restricted IS DISTINCT FROM restricted OR federation_pending
     ORDER BY id`;
  counts.sources = flips.map((f) => f.id);
  opts.onStart?.({ sources: counts.sources });
  const settled = new Set<string>();
  const settle = async (tx: Sql, sources: readonly { id: string; restricted: boolean }[]) => {
    if (sources.length === 0) return;
    const basis = sources.map(({ id, restricted }) => ({ id, restricted }));
    // Row locks in id order before the update, so two reconciles settling
    // overlapping sources never wait on each other in a cycle.
    await tx`
      SELECT id FROM conditions.source
       WHERE id = ANY(${basis.map((b) => b.id)}::text[])
       ORDER BY id FOR NO KEY UPDATE`;
    await tx`
      UPDATE conditions.source s
         SET federation_restricted = b.restricted, federation_pending = false
        FROM jsonb_to_recordset(${tx.json(basis)}) AS b(id text, restricted boolean)
       WHERE s.id = b.id`;
    for (const b of basis) settled.add(b.id);
  };
  // In listing order, as `sources`.
  const done = () => {
    counts.settled = counts.sources.filter((id) => settled.has(id));
    return counts;
  };
  const stopped = () => opts.signal?.aborted === true;
  if (stopped()) return done();
  const unjournalled = (f: (typeof flips)[number]) => f.basis === null && !f.pending;
  await sql.begin((tx) => settle(tx, flips.filter(unjournalled)));
  const size = opts.batchSize ?? 500;
  for (const flip of flips.filter((f) => !unjournalled(f))) {
    const units = flip.restricted ? RECORD_CLASSES : [...RECORD_CLASSES, "observation" as const];
    let first = true;
    for (const [u, unit] of units.entries()) {
      let after: string | number | undefined;
      for (;;) {
        if (stopped()) return done();
        const page = (await sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${flip.id}))`;
          if (first) {
            await tx`
              UPDATE conditions.source SET federation_pending = true
               WHERE id = ${flip.id} AND NOT federation_pending`;
          }
          let ids: (string | number)[];
          let journalled: number;
          if (unit === "observation") {
            const series = await tx<{ series_id: string }[]>`
              SELECT series_id FROM conditions.observation_latest
               WHERE source_id = ${flip.id} AND series_id > ${after ?? 0}
               ORDER BY series_id LIMIT ${size}`;
            ids = series.map((s) => Number(s.series_id));
            journalled = await publishReadings(tx, ids as number[]);
          } else {
            const records = await tx.unsafe<{ id: string }[]>(
              `SELECT id FROM conditions.${unit} WHERE source_id = $1 AND id > $2
                ORDER BY id LIMIT $3`,
              [flip.id, after ?? "", size],
            );
            ids = records.map((r) => r.id);
            journalled = flip.restricted
              ? await retract(tx, unit, ids as string[])
              : await publish(tx, unit, ids as string[]);
          }
          if (ids.length < size && u === units.length - 1) await settle(tx, [flip]);
          return { ids, journalled };
        })) as { ids: (string | number)[]; journalled: number };
        first = false;
        counts.journalled += page.journalled;
        opts.onBatch?.({ source: flip.id, journalled: counts.journalled });
        if (page.ids.length < size) break;
        after = page.ids.at(-1);
      }
    }
  }
  return done();
}
