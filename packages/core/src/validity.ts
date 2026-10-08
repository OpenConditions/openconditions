import type { Registry } from "@openconditions/model";
import { CROWD_SOURCE_ID } from "./live-rows.js";
import type { QueryRunner } from "./query-runner.js";

type Rec = Record<string, unknown>;
type PropertyRetention = Pick<Registry, "property">;

/** A source's readings stay current for at least half an hour after its last successful poll. */
export const MIN_POLLED_VALIDITY_SEC = 1800;

/**
 * SQL for when the last successful poll of the `source_status` row aliased
 * `t` finished (its publication committed), else when it began: what read
 * validity, fusion freshness and freshness flips all date a source by.
 */
export function lastSuccessEnd(t: string): string {
  return `COALESCE((SELECT max(pa.finished_at) FROM conditions.source_poll_attempt pa
                     WHERE pa.source = ${t}.source AND pa.attempted_at = ${t}.last_success_at),
                   ${t}.last_success_at)`;
}

/**
 * Whether a reading is current for as long as its source keeps polling: a
 * bulk feed's reading of a change-only property. Such a reading is written
 * once per change and stores no `validUntil`; it is current until
 * `max(30 min, two cadences)` after its source's last successful poll,
 * computed when read ({@link withPolledValidity}).
 */
export function validWhilePolled(registry: PropertyRetention, record: Rec): boolean {
  const provenance = record["provenance"] as Rec | undefined;
  return (
    provenance?.["origin"] === "feed" &&
    provenance["accessMode"] === "bulk" &&
    registry.property(record["property"] as string)?.retention?.changeOnly === true
  );
}

/**
 * Whose polling a reading's validity follows: a source this instance polls,
 * or (`peer`) a source as it arrives from the peer that sealed the reading.
 * A fused contributor names no peer: its source's own polling counts, else
 * its latest arrival from any peer.
 */
interface Polled {
  source: string;
  peer?: string;
  fused?: true;
}

/**
 * The sources whose polling a stored reading's validity follows: its own
 * source for a reading {@link validWhilePolled} (the peer's, for one a peer
 * sent), and for a fused reading of a change-only property every
 * contributing feed (a crowd contributor keeps its own lifetime). None for a
 * reading that states its own `validUntil`.
 */
function polledSources(registry: PropertyRetention, record: Rec): Polled[] {
  if (record["validUntil"] !== undefined) return [];
  const provenance = record["provenance"] as Rec | undefined;
  if (validWhilePolled(registry, record)) {
    const source = provenance!["sourceId"] as string;
    const chain = provenance!["originChain"] as unknown[] | undefined;
    return chain !== undefined && chain.length > 0
      ? [{ source, peer: provenance!["instanceId"] as string }]
      : [{ source }];
  }
  if (
    provenance?.["origin"] !== "derived" ||
    provenance["accessMode"] !== "bulk" ||
    registry.property(record["property"] as string)?.retention?.changeOnly !== true
  ) {
    return [];
  }
  const merged = (provenance["mergedSources"] as { source: string }[] | undefined) ?? [];
  return merged
    .filter((m) => m.source !== CROWD_SOURCE_ID)
    .map((m) => ({ source: m.source, fused: true }));
}

const peerKey = (peer: string, source: string) => `${peer}\u0000${source}`;

/**
 * The records with the `validUntil` their sources' polling gives them: a
 * reading {@link validWhilePolled} is current until its source's last
 * successful poll finished plus `max(30 min, two of its shortest data
 * cadences)`; one a peer sent, until this instance last received its source
 * from that peer plus that window (`federation_source_receipt`; 30 min where
 * the source is not in this catalogue); a fused reading of a change-only
 * property until the latest such instant of its contributing feeds. A source
 * that has not polled successfully yet, or arrived from no peer, gives none.
 * Every other record is returned as it is. At most two statements, whatever
 * the number of records.
 */
export async function withPolledValidity<T extends Rec>(
  db: QueryRunner,
  registry: PropertyRetention,
  records: readonly T[],
): Promise<T[]> {
  const sourcesOf = records.map((r) => polledSources(registry, r));
  const all = sourcesOf.flat();
  const local = [...new Set(all.filter((p) => p.peer === undefined).map((p) => p.source))];
  const federated = [
    ...new Set(all.filter((p) => p.peer !== undefined || p.fused).map((p) => p.source)),
  ];
  if (local.length === 0 && federated.length === 0) return [...records];
  const until = new Map<string, number>();
  if (local.length > 0) {
    // A poll is dated by when its successful attempt finished (its publication
    // committed), not when it began: a long poll would otherwise commit an
    // already lapsed success.
    const rows = await db.execute<{ source: string; valid_until: Date | string }[]>(
      `SELECT ss.source, ${lastSuccessEnd("ss")}
                + make_interval(secs => GREATEST(${MIN_POLLED_VALIDITY_SEC}, 2 * s.cadence_sec)) AS valid_until
         FROM conditions.source_status ss
         JOIN conditions.source s ON s.id = ss.source
        WHERE ss.source = ANY($1::text[]) AND ss.last_success_at IS NOT NULL`,
      [local],
    );
    for (const r of rows) until.set(r.source, new Date(r.valid_until).getTime());
  }
  const received = new Map<string, number>();
  const anyPeer = new Map<string, number>();
  if (federated.length > 0) {
    const rows = await db.execute<
      { peer_instance_id: string; source_id: string; valid_until: Date | string }[]
    >(
      `SELECT r.peer_instance_id, r.source_id,
              r.last_received_at + make_interval(
                secs => GREATEST(${MIN_POLLED_VALIDITY_SEC}, 2 * COALESCE(s.cadence_sec, 0))) AS valid_until
         FROM conditions.federation_source_receipt r
         LEFT JOIN conditions.source s ON s.id = r.source_id
        WHERE r.source_id = ANY($1::text[])`,
      [federated],
    );
    for (const r of rows) {
      const t = new Date(r.valid_until).getTime();
      received.set(peerKey(r.peer_instance_id, r.source_id), t);
      anyPeer.set(r.source_id, Math.max(anyPeer.get(r.source_id) ?? t, t));
    }
  }
  const instantOf = (p: Polled): number | undefined =>
    p.peer !== undefined
      ? received.get(peerKey(p.peer, p.source))
      : (until.get(p.source) ?? (p.fused ? anyPeer.get(p.source) : undefined));
  return records.map((record, i) => {
    const instants = sourcesOf[i]!.flatMap((p) => {
      const t = instantOf(p);
      return t === undefined ? [] : [t];
    });
    if (instants.length === 0) return record;
    return { ...record, validUntil: new Date(Math.max(...instants)).toISOString() };
  });
}
