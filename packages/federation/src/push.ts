/**
 * Webhook push delivery — a LATENCY optimization over the pull contract, NOT a
 * second ordering authority and NOT the completeness channel.
 *
 * THE CHANNEL CONTRACT (read this before touching the cursor).
 *  - The webhook push channel delivers ONLY the priority classes when
 *    `priorityOnly` is set (closure/crash) — a low-latency alert path. Under
 *    `priorityOnly: false` it is full-fidelity (every subscriber-matching event).
 *  - `subscription.cursor` is the PUSH-CHANNEL cursor: it advances ONLY over
 *    events that are eligible for THIS channel. Under `priorityOnly` the SQL scan
 *    is restricted to priority classes ({@link readOutbox}'s `priorityClasses`),
 *    so the frontier is over the priority subsequence and the cursor can NEVER be
 *    advanced past a non-priority (but subscriber-filter-matching) event — such an
 *    event is simply not part of the push channel. This closes the skip where a
 *    matching-but-non-priority event would be stranded behind an advanced cursor.
 *  - COMPLETENESS (every matching event, priority AND non-priority) is guaranteed
 *    by the peer's OWN independent pull of `/peer/outbox` with the peer's own
 *    cursor — pull is NOT restricted by `priorityOnly`. A push failure loses
 *    nothing: the publisher does not advance the push cursor (so the same priority
 *    events re-push, idempotently — the peer dedups on the composite cursor), and
 *    the peer's next pull covers everything regardless.
 *
 * Consecutive failures accrue on the row; once they reach the threshold the row
 * flips to `push_disabled` and the publisher stops pushing (the peer stays whole
 * on pull). A recovered peer re-enables push with a PATCH (resets the counter).
 */
import type postgres from "postgres";
import type { FederationFilter } from "./filter.js";
import { signMessage } from "./http-signature.js";
import type { InstanceKey } from "./keys.js";
import { readOutbox, type OutboxEntry, type OutboxPage } from "./outbox.js";
import type { FederationSubscription } from "./subscriptions.js";

/** ActivityStreams content type the pushed page (and the pull outbox) use. */
const ACTIVITY_JSON = "application/activity+json";

/** Consecutive push failures that flip a subscription to `push_disabled`. */
export const PUSH_FAILURE_THRESHOLD = 5;

/**
 * The high-priority event classes a `priorityOnly` push carries (closure/crash).
 * A push channel is a low-latency alert path, not a full mirror — the bulk
 * stream stays on the peer's pull. Delete tombstones always pass (a retraction of
 * any event must reach a subscriber that might still hold it). This ordered list
 * is what feeds {@link readOutbox}'s SQL-level `priorityClasses` restriction.
 */
export const PRIORITY_EVENT_TYPES: readonly string[] = ["road_closure", "lane_closure", "accident"];

const PRIORITY_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PRIORITY_EVENT_TYPES);

/** Whether an entry qualifies for a `priorityOnly` push. Used by the SSE channel
 *  (whose live poll post-filters) — the webhook channel restricts at SQL instead. */
export function isPriorityEntry(
  entry: OutboxEntry,
  priorityTypes: ReadonlySet<string> = PRIORITY_EVENT_TYPE_SET
): boolean {
  if (entry.operation === "delete") return true;
  const type = (entry.observation as { type?: string } | undefined)?.type;
  return type !== undefined && priorityTypes.has(type);
}

export interface DeliverWebhookOptions {
  /** The instance signing key (the pushed page is RFC-9421 signed with it). */
  signingKey: InstanceKey;
  /** Egress fetch — defaults to the caller's guarded fetch; injectable for tests. */
  fetchImpl: typeof fetch;
  /** The `partOf` collection URL stamped on the pushed page. */
  partOf: string;
  /** Filter evaluation instant (ISO 8601); defaults to the real clock. */
  now?: string;
  /** Override the priority class list (the SQL-level push-channel restriction). */
  priorityTypes?: readonly string[];
  /** Consecutive-failure ceiling; defaults to {@link PUSH_FAILURE_THRESHOLD}. */
  failureThreshold?: number;
  /** Outbox page size per delivery. */
  limit?: number;
}

export type DeliverWebhookOutcome =
  | { status: "delivered"; delivered: number; advancedTo: string; httpStatus: number }
  | { status: "empty"; delivered: 0; advancedTo: string }
  | { status: "failed"; pushFailures: number; httpStatus?: number }
  | { status: "disabled"; pushFailures: number; httpStatus?: number };

/**
 * Delivers one outbox page to a webhook subscription's inbox. Under
 * `priorityOnly` the outbox scan itself is restricted to the priority classes
 * (via {@link readOutbox}'s SQL `priorityClasses`), so the page frontier — and
 * thus the advanced cursor — is over the PRIORITY subsequence only and can never
 * skip a non-priority matching event (that event is not in this channel;
 * completeness for it is the peer's pull). Then:
 *  - on 2xx: advances the cursor to the priority-channel frontier, resets the
 *    failure counter;
 *  - on failure: increments the counter (disabling push at the threshold) and
 *    LEAVES the cursor untouched, so the same priority events re-push and the
 *    peer's pull catch-up is gap-free;
 *  - when the (priority-restricted) scan is empty: advances the cursor over any
 *    scanned priority rows that the subscriber filter then dropped, without a
 *    POST — no priority row that matches is ever skipped.
 */
export async function deliverWebhook(
  sql: postgres.Sql,
  subscription: FederationSubscription,
  opts: DeliverWebhookOptions
): Promise<DeliverWebhookOutcome> {
  const now = opts.now ?? new Date().toISOString();
  const threshold = opts.failureThreshold ?? PUSH_FAILURE_THRESHOLD;

  const page = await readOutbox(sql, {
    after: subscription.cursor,
    filter: subscription.filter,
    ...(subscription.priorityOnly
      ? { priorityClasses: opts.priorityTypes ?? PRIORITY_EVENT_TYPES }
      : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    partOf: opts.partOf,
    now,
  });

  // The scan is already priority-restricted at SQL when priorityOnly, so
  // orderedItems are exactly the push-channel items the subscriber filter kept.
  const items = page.orderedItems;

  if (items.length === 0) {
    // Nothing to push. The frontier is over the (priority-restricted) scan, so
    // advancing here only skips priority rows the subscriber filter dropped —
    // never a non-priority matching event (those are not scanned at all).
    if (page.highWaterMark !== subscription.cursor) {
      await sql`
        UPDATE conditions.federation_subscription
        SET cursor = ${page.highWaterMark}, push_failures = 0, updated_at = ${new Date(now)}
        WHERE id = ${subscription.id}`;
    }
    return { status: "empty", delivered: 0, advancedTo: page.highWaterMark };
  }

  const payload: OutboxPage = {
    type: "OrderedCollectionPage",
    partOf: opts.partOf,
    highWaterMark: page.highWaterMark,
    orderedItems: items,
  };
  const body = Buffer.from(JSON.stringify(payload));

  let httpStatus: number | undefined;
  try {
    const signed = await signMessage({
      method: "POST",
      url: subscription.inboxUrl!,
      headers: { "content-type": ACTIVITY_JSON },
      body,
      keyId: opts.signingKey.keyId,
      privateKey: opts.signingKey.privateKey,
    });
    const res = await opts.fetchImpl(subscription.inboxUrl!, {
      method: "POST",
      headers: signed.headers,
      body,
    });
    httpStatus = res.status;
  } catch {
    httpStatus = undefined;
  }

  if (httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300) {
    await sql`
      UPDATE conditions.federation_subscription
      SET cursor = ${page.highWaterMark}, push_failures = 0, status = 'active',
          updated_at = ${new Date(now)}
      WHERE id = ${subscription.id}`;
    return {
      status: "delivered",
      delivered: items.length,
      advancedTo: page.highWaterMark,
      httpStatus,
    };
  }

  const pushFailures = subscription.pushFailures + 1;
  const disabled = pushFailures >= threshold;
  await sql`
    UPDATE conditions.federation_subscription
    SET push_failures = ${pushFailures}, status = ${disabled ? "push_disabled" : subscription.status},
        updated_at = ${new Date(now)}
    WHERE id = ${subscription.id}`;
  return {
    status: disabled ? "disabled" : "failed",
    pushFailures,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

export interface WebhookCycleResult {
  attempted: number;
  delivered: number;
  failed: number;
  disabled: number;
}

/**
 * Runs one delivery pass over every active webhook subscription (the cron body).
 * A `push_disabled` row is skipped — that peer is on pull now. Each subscription
 * is loaded fresh so its current cursor/failure counter is honoured.
 */
export async function runWebhookDeliveryCycle(
  sql: postgres.Sql,
  opts: DeliverWebhookOptions
): Promise<WebhookCycleResult> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM conditions.federation_subscription
    WHERE delivery_mode = 'webhook' AND status = 'active'
    ORDER BY created_at ASC`;

  const result: WebhookCycleResult = { attempted: 0, delivered: 0, failed: 0, disabled: 0 };
  for (const { id } of rows) {
    const [row] = await sql<
      {
        id: string;
        peer_id: string;
        filter: FederationFilter;
        delivery_mode: FederationSubscription["deliveryMode"];
        inbox_url: string | null;
        cursor: string;
        priority_only: boolean;
        push_failures: number;
        status: FederationSubscription["status"];
        created_at: Date;
        updated_at: Date;
      }[]
    >`SELECT * FROM conditions.federation_subscription WHERE id = ${id}`;
    if (!row) continue;
    const subscription: FederationSubscription = {
      id: row.id,
      peerId: row.peer_id,
      filter: row.filter,
      deliveryMode: row.delivery_mode,
      inboxUrl: row.inbox_url,
      cursor: row.cursor,
      priorityOnly: row.priority_only,
      pushFailures: row.push_failures,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
    result.attempted += 1;
    const outcome = await deliverWebhook(sql, subscription, opts);
    if (outcome.status === "delivered") result.delivered += 1;
    else if (outcome.status === "failed") result.failed += 1;
    else if (outcome.status === "disabled") result.disabled += 1;
  }
  return result;
}
