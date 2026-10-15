/**
 * The pull side of peering: following a pinned peer's journal with this
 * instance's own cursor, for a peer whose record asks for it (`pull`). The
 * push is a latency optimization; the pull is complete whatever the push
 * carries (a `priorityOnly` push carries only priority entries) and whether
 * or not it was disabled.
 *
 * Each page is a signed request under this instance's key, so the peer
 * serves its pinned tier's window; the response must carry the peer's
 * signature under a pinned key over the body as received. A page lands
 * through the same inbox as a pushed one (`ingestFederatedPage`), which
 * lands a record no newer than the stored copy, or a retraction of a copy
 * already ended, as `stale`: a page that arrives by push and by pull lands
 * once. The cursor (`federation_peer_cursor`) advances to the page's
 * `highWaterMark` only once the page landed, so a failed page is read again
 * and none is skipped. A cursor that has not reached the live tail reads
 * `/peer/backfill`, the catch-up route; the live tail is read from
 * `/peer/outbox`.
 */
import { ingestFederatedPage } from "@openconditions/contributions-api/federation/inbox";
import {
  decodeOutboxCursor,
  type InstanceKey,
  loadPeerVersions,
  type NonceStore,
  OUTBOX_CURSOR_START,
  OUTBOX_MAX_LIMIT,
  type PeerRecord,
  peerRouteUrl,
  type RecordFilter,
  recordAvailability,
  recordPeerFailure,
  signedPeerRequest,
  verifyPeerResponse,
} from "@openconditions/federation";
import type { Registry } from "@openconditions/model";
import type postgres from "postgres";

/** The most pages one pull of a peer reads before it yields. */
export const PULL_MAX_PAGES = 20;

export interface PullContext {
  registry: Registry;
  localInstanceId: string;
  signingKey: InstanceKey;
  fetchImpl: typeof fetch;
  /** Replay cache of the peers' response signatures. */
  nonceStore: NonceStore;
  now: () => string;
  /** Pages read at most; default {@link PULL_MAX_PAGES}. */
  maxPages?: number;
}

export interface PullResult {
  pages: number;
  accepted: number;
  stale: number;
  tombstoned: number;
  liveness: number;
  skipped: number;
  /** The cursor the pull reached. */
  cursor: string;
  /** The peer's history before this instance's window lives only in its archive. */
  beyondWindow?: true;
  /** Why the pull stopped short, when it did. */
  error?: string;
}

/** The query string of a filter, as the peer's outbox reads it. */
export function filterQuery(filter: RecordFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.bbox !== undefined) params.set("bbox", filter.bbox.join(","));
  for (const name of ["classes", "kinds", "domains", "properties", "privacyClasses"] as const) {
    const values = filter[name];
    if (values !== undefined) params.set(name, values.join(","));
  }
  if (filter.minEvidenceTier !== undefined) params.set("minEvidenceTier", filter.minEvidenceTier);
  if (filter.maxAgeSec !== undefined) params.set("maxAgeSec", String(filter.maxAgeSec));
  if (filter.sourceLiveness === true) params.set("sourceLiveness", "true");
  return params;
}

async function readCursor(sql: postgres.Sql, peerId: string): Promise<string> {
  const [row] = await sql<{ cursor: string }[]>`
    SELECT cursor FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${peerId}`;
  return row?.cursor ?? "0.0";
}

async function storeCursor(
  sql: postgres.Sql,
  peerId: string,
  cursor: string,
  now: string,
): Promise<void> {
  await sql`
    INSERT INTO conditions.federation_peer_cursor (peer_instance_id, cursor, updated_at)
    VALUES (${peerId}, ${cursor}, ${now})
    ON CONFLICT (peer_instance_id) DO UPDATE
      SET cursor = excluded.cursor, updated_at = excluded.updated_at`;
}

/** Whether the cursor `b` is past `a` in the journal's `(txid, seq)` order. */
function after(a: string, b: string): boolean {
  const x = decodeOutboxCursor(a) ?? OUTBOX_CURSOR_START;
  const y = decodeOutboxCursor(b);
  if (y === null) return false;
  const tx = BigInt(x.txid);
  const ty = BigInt(y.txid);
  return ty > tx || (ty === tx && y.seq > x.seq);
}

/** Reads and lands what is new in `peer`'s journal; never throws for the peer's answers. */
export async function pullPeer(
  sql: postgres.Sql,
  peer: PeerRecord & { pull: { filter: RecordFilter } },
  ctx: PullContext,
): Promise<PullResult> {
  const result: PullResult = {
    pages: 0,
    accepted: 0,
    stale: 0,
    tombstoned: 0,
    liveness: 0,
    skipped: 0,
    cursor: await readCursor(sql, peer.instanceId),
  };
  const peerVersions = await loadPeerVersions(sql, peer.instanceId);
  if (peerVersions === undefined) {
    return { ...result, error: "the peer's capabilities are not yet verified" };
  }
  const query = filterQuery(peer.pull.filter);
  query.set("limit", String(OUTBOX_MAX_LIMIT));
  let catchingUp = result.cursor === "0.0";
  for (let i = 0; i < (ctx.maxPages ?? PULL_MAX_PAGES); i++) {
    query.set("after", result.cursor);
    const url = `${peerRouteUrl(peer, catchingUp ? "/peer/backfill" : "/peer/outbox")}?${query}`;
    let res: Response;
    let body: Uint8Array;
    try {
      res = await signedPeerRequest(ctx.fetchImpl, ctx.signingKey, "GET", url);
      body = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      await recordAvailability(sql, peer.instanceId, false, ctx.now());
      return { ...result, error: `the peer could not be reached: ${String(err)}` };
    }
    if (res.status === 429 || res.status === 503) {
      return { ...result, error: `the peer asked to retry later (${res.status})` };
    }
    if (res.status !== 200) {
      await recordAvailability(sql, peer.instanceId, false, ctx.now());
      return { ...result, error: `the peer answered ${res.status}` };
    }
    const signed = { status: 200, headers: res.headers, url, body };
    if (!(await verifyPeerResponse(peer, signed, ctx.nonceStore))) {
      await recordPeerFailure(sql, peer.instanceId, "signature", ctx.now());
      return { ...result, error: "the page does not carry the peer's signature" };
    }
    let page: { highWaterMark?: unknown; next?: unknown; beyondWindow?: unknown };
    try {
      page = JSON.parse(Buffer.from(body).toString("utf8")) as typeof page;
    } catch {
      await recordPeerFailure(sql, peer.instanceId, "schema", ctx.now());
      return { ...result, error: "the page is not JSON" };
    }
    const frontier = typeof page.highWaterMark === "string" ? page.highWaterMark : "";
    if (decodeOutboxCursor(frontier) === null) {
      await recordPeerFailure(sql, peer.instanceId, "schema", ctx.now());
      return { ...result, error: "the page carries no cursor" };
    }
    const landed = await ingestFederatedPage(sql, page, {
      registry: ctx.registry,
      localInstanceId: ctx.localInstanceId,
      peerInstanceId: peer.instanceId,
      peerVersions,
      now: ctx.now(),
    });
    result.pages += 1;
    result.accepted += landed.accepted;
    result.stale += landed.stale;
    result.tombstoned += landed.tombstoned;
    result.liveness += landed.liveness;
    result.skipped += landed.skipped.length;
    if (landed.skipped.length > 0) {
      await recordPeerFailure(sql, peer.instanceId, "schema", ctx.now(), landed.skipped.length);
    }
    if (page.beyondWindow === true) result.beyondWindow = true;
    if (after(result.cursor, frontier)) {
      await storeCursor(sql, peer.instanceId, frontier, ctx.now());
      result.cursor = frontier;
    }
    if (page.next === undefined) break;
    catchingUp = true;
  }
  await recordAvailability(sql, peer.instanceId, true, ctx.now());
  return result;
}
