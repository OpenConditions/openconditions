import type { RevisionedClass } from "@openconditions/core/server";
import type { Registry } from "@openconditions/model";
import type { Sql } from "./bulk.js";
import { updateCanonicalView } from "./canonical-view.js";
import { storeRecords } from "./write-records.js";

/**
 * How long a peer that sends liveness may stay silent about a source (no
 * record and no liveness of it arriving) before its copies of the source end:
 * twelve liveness intervals, so a push or pull outage of an hour or so ends
 * nothing.
 */
export const PEER_LIVENESS_LAPSE_SEC = 7200;

const CLASSES: readonly RevisionedClass[] = ["situation", "feature", "offer"];

/**
 * A live copy, without an expiry of its own, of a peer that sends liveness of
 * its source and has been silent about it past the lapse window: the larger
 * of `$3` seconds and four of the source's cadences, where this catalogue
 * knows it. ($1 = now, $2 = this instance's id, $3 = the lapse window)
 */
export const PEER_LAPSED = `r.tombstoned_at IS NULL AND r.instance_id <> $2
  AND r.access_mode = 'bulk' AND r.expires_at IS NULL
  AND EXISTS (
    SELECT 1 FROM conditions.federation_source_receipt fr
      LEFT JOIN conditions.source s ON s.id = fr.source_id
     WHERE fr.peer_instance_id = r.instance_id AND fr.source_id = r.source_id
       AND fr.liveness_at IS NOT NULL
       AND fr.last_received_at < $1::timestamptz
             - make_interval(secs => GREATEST($3::int, 4 * COALESCE(s.cadence_sec, 0))))`;

/**
 * Notes the copies of `cls` the sweep just ended for their peer's silence, at
 * the revision they kept, so the peer's return can bring them back.
 */
export async function recordLapsedCopies(
  tx: Sql,
  cls: RevisionedClass,
  ids: readonly string[],
  now: string,
): Promise<void> {
  if (ids.length === 0) return;
  await tx.unsafe(
    `INSERT INTO conditions.federation_lapsed_copy
       (record_class, record_id, peer_instance_id, source_id, revision, lapsed_at)
     SELECT $1, r.id, r.instance_id, r.source_id, r.revision, $3::timestamptz
       FROM conditions.${cls} r WHERE r.id = ANY($2::text[])
     ON CONFLICT (record_class, record_id) DO UPDATE SET
       peer_instance_id = excluded.peer_instance_id, source_id = excluded.source_id,
       revision = excluded.revision, lapsed_at = excluded.lapsed_at`,
    [cls, ids as string[], now],
  );
}

/**
 * Whether a copy is one the sweep ended for its peer's silence and that is
 * still as it ended: a retraction of it by its peer is then the peer's to
 * apply, not a copy already ended.
 */
export async function isLapsedCopy(tx: Sql, cls: string, id: string): Promise<boolean> {
  const rows = await tx.unsafe<{ one: number }[]>(
    `SELECT 1 AS one FROM conditions.federation_lapsed_copy l
       JOIN conditions.${cls} r ON r.id = l.record_id
      WHERE l.record_class = $1 AND l.record_id = $2
        AND r.revision = l.revision AND r.tombstone_reason = 'expired'`,
    [cls, id],
  );
  return rows.length > 0;
}

/**
 * Brings back the copies of `peer`'s `sourceId` the sweep ended for the
 * peer's silence, now that its liveness of the source arrived again: each
 * copy still at the revision it ended at and ended so is stored live again
 * as it was (a quiet record is never re-sent). A copy the peer changed or
 * retracted since stays as the peer left it. Every note of the source is
 * then forgotten. Run under the source's advisory lock. Returns how many
 * copies came back.
 */
export async function restoreLapsedCopies(
  tx: Sql,
  registry: Registry,
  peer: string,
  sourceId: string,
  ctx: { instanceId: string; now: string },
): Promise<number> {
  const notes = await tx<{ record_class: RevisionedClass; record_id: string; revision: number }[]>`
    DELETE FROM conditions.federation_lapsed_copy
     WHERE peer_instance_id = ${peer} AND source_id = ${sourceId}
    RETURNING record_class, record_id, revision`;
  let restored = 0;
  for (const cls of CLASSES) {
    const ofClass = notes.filter((n) => n.record_class === cls);
    if (ofClass.length === 0) continue;
    const rows = await tx.unsafe<{ id: string; record: Record<string, unknown> }[]>(
      `SELECT r.id, r.record FROM conditions.${cls} r
         JOIN jsonb_to_recordset($1::text::jsonb) AS n(record_id text, revision int)
           ON n.record_id = r.id AND n.revision = r.revision
        WHERE r.tombstone_reason = 'expired' AND r.instance_id = $2`,
      [JSON.stringify(ofClass), peer],
    );
    if (rows.length === 0) continue;
    const live = rows.map(({ record }) => {
      const { tombstone: _tombstone, ...rest } = record;
      return rest;
    });
    await storeRecords(tx, cls, live, registry);
    if (cls === "feature") {
      await updateCanonicalView(
        tx,
        registry,
        { sourceId, featureIds: rows.map((r) => r.id), observations: [] },
        ctx,
      );
    }
    restored += rows.length;
  }
  return restored;
}
