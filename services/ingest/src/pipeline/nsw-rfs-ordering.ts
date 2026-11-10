import type { ParseOutput } from "@openconditions/ingest-framework";
import type postgres from "postgres";

type Clock = NonNullable<ParseOutput["nswRfsOrdering"]>;
type Receipt = Clock["incidents"][number] & { published: string };

/** Caller holds the source advisory lock, in the publication transaction.
 * Refuse the whole poll before writing records, status or accepting validators.
 * Receipts intentionally outlive record/history retention; omission has no authority.
 */
export async function checkNswRfsOrdering(
  tx: postgres.TransactionSql,
  sourceId: string,
  clock: Clock,
): Promise<void> {
  const prior = new Map(
    (
      await tx<Receipt[]>`SELECT incident_id AS id, sent, published, content, expiry
      FROM conditions.nsw_rfs_clock WHERE source_id = ${sourceId}
        AND incident_id = ANY(${["", ...clock.incidents.map((i) => i.id)]}::text[])`
    ).map((r) => [r.id, r]),
  );
  const envelope = prior.get("");
  if (envelope && Date.parse(clock.published) < Date.parse(envelope.published))
    throw new Error("RFS ordering: regressed distribution");
  for (const incident of clock.incidents) {
    const old = prior.get(incident.id);
    if (!old) {
      // Upgrade safety: a surviving pre-receipt record/history is a lower
      // bound. Equal-time content cannot be authenticated from that projection,
      // so require a strictly newer native revision to initialize its receipt.
      const id = `oc:situation:${sourceId}:${incident.id}`;
      const legacy = await tx<{ sent: string }[]>`
        SELECT record #>> '{provenance,sourceUpdatedAt}' AS sent
          FROM conditions.situation WHERE source_id = ${sourceId} AND id = ${id}
        UNION ALL SELECT snapshot #>> '{provenance,sourceUpdatedAt}' AS sent
          FROM conditions.situation_revision WHERE situation_id = ${id}`;
      if (legacy.some((r) => Date.parse(r.sent) >= Date.parse(incident.sent)))
        throw new Error(`RFS ordering: unreceipted retained revision ${incident.id}`);
      continue;
    }
    const delta = Date.parse(incident.sent) - Date.parse(old.sent);
    if (
      delta < 0 ||
      (delta === 0 &&
        (incident.content !== old.content ||
          (incident.expiry !== old.expiry &&
            Date.parse(clock.published) <= Date.parse(old.published))))
    )
      throw new Error(`RFS ordering: regressed or conflicting incident ${incident.id}`);
  }
  for (const incident of [
    ...clock.incidents,
    { id: "", sent: clock.published, content: "", expiry: "" },
  ]) {
    await tx`INSERT INTO conditions.nsw_rfs_clock
      (source_id, incident_id, sent, published, content, expiry)
      VALUES (${sourceId}, ${incident.id}, ${incident.sent}, ${clock.published}, ${incident.content}, ${incident.expiry})
      ON CONFLICT (source_id, incident_id) DO UPDATE SET sent = EXCLUDED.sent,
        published = EXCLUDED.published, content = EXCLUDED.content, expiry = EXCLUDED.expiry`;
  }
}
