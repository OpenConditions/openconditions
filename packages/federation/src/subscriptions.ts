/**
 * Federation subscription storage and validation (`conditions.federation_subscription`).
 *
 * A subscription is the relationship a peer establishes to receive this
 * instance's outbox, plus HOW it wants delivery. `deliveryMode` layers push
 * (webhook/sse) as a LATENCY optimization over the proven pull contract: the
 * ordering authority is the outbox's composite `(txid, seq)` cursor.
 *
 * `cursor` is the PUSH-CHANNEL cursor. Under `priorityOnly` the push channel
 * carries ONLY the priority classes (closure/crash), and this cursor advances
 * ONLY across those priority events (the scan is priority-restricted at SQL) —
 * it can never be advanced past a non-priority but subscriber-matching event,
 * because such an event is not part of the push channel. COMPLETENESS (every
 * matching event, priority and non-priority) is the peer's OWN independent pull
 * of `/peer/outbox`, which is never `priorityOnly`-restricted; push is a latency
 * optimization for priority events, never the completeness channel. A dropped
 * push loses nothing: the push cursor is not advanced (priority events re-push,
 * idempotently) and the peer's pull covers everything regardless.
 *
 * Validation is fail-closed: a push mode (webhook/sse) demands a NARROW filter
 * (at least a bbox, a type allow-list, a privacyClass allow-list, or a maxAge
 * bound) so a subscriber cannot ask the publisher to firehose its whole journal
 * over a push channel, and a webhook demands a public https `inboxUrl` (an
 * SSRF-guarded target — the same egress guard the POST later dials through).
 */
import type postgres from "postgres";
import { assertPublicUrl } from "@openconditions/ingest-framework";
import type { FederationFilter } from "./filter.js";

export type DeliveryMode = "pull" | "webhook" | "sse";
export type SubscriptionStatus = "active" | "push_disabled";

/** The delivery modes a subscription may request. */
export const DELIVERY_MODES: readonly DeliveryMode[] = ["pull", "webhook", "sse"];

export interface FederationSubscription {
  id: string;
  peerId: string;
  filter: FederationFilter;
  deliveryMode: DeliveryMode;
  inboxUrl: string | null;
  /** Last composite `(txid, seq)` cursor delivered/acked to this peer (wire form). */
  cursor: string;
  priorityOnly: boolean;
  pushFailures: number;
  status: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubscriptionInput {
  filter?: FederationFilter;
  deliveryMode?: DeliveryMode;
  inboxUrl?: string;
  priorityOnly?: boolean;
}

export interface UpdateSubscriptionInput {
  filter?: FederationFilter;
  deliveryMode?: DeliveryMode;
  inboxUrl?: string | null;
  priorityOnly?: boolean;
}

/** Why a subscription request was rejected; the route maps each to an HTTP status. */
export type SubscriptionValidationCode =
  | "invalid-delivery-mode"
  | "over-broad-filter"
  | "invalid-filter"
  | "inbox-required"
  | "inbox-not-public";

export class SubscriptionValidationError extends Error {
  readonly code: SubscriptionValidationCode;
  /** A narrower filter to suggest back to the caller (set for over-broad-filter). */
  readonly recommended?: FederationFilter;

  constructor(code: SubscriptionValidationCode, message: string, recommended?: FederationFilter) {
    super(message);
    this.name = "SubscriptionValidationError";
    this.code = code;
    if (recommended !== undefined) this.recommended = recommended;
  }
}

/** The high-priority event classes a push channel is meant for: a narrower
 *  `types` recommendation handed back when a webhook/sse filter is over-broad. */
const RECOMMENDED_NARROW_TYPES = ["road_closure", "lane_closure", "accident"];

/** Rejects a `types`/`privacyClasses` value that is not a non-empty array of
 *  non-empty strings (an open vocabulary — only blank/malformed entries fail). */
function assertStringAllowList(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    throw new SubscriptionValidationError(
      "invalid-filter",
      `${label} must be a non-empty array of non-empty strings`
    );
  }
}

/**
 * Validates filter VALUES (not just key presence). Untrusted JSON reaches here,
 * so each present field is range/shape checked and a violation throws
 * {@link SubscriptionValidationError} (`invalid-filter`) the route turns into 422.
 * Applied for every delivery mode, so a `pull` subscription cannot store a
 * malformed bbox/maxAge that would later mis-scope its pages either.
 */
function validateFilterValues(filter: FederationFilter): void {
  // Fail closed on a non-object filter (a string/array would let every field read
  // below be `undefined` and pass — then get stored as non-object JSON).
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) {
    throw new SubscriptionValidationError("invalid-filter", "filter must be a JSON object");
  }

  const bbox: unknown = filter.bbox;
  if (bbox !== undefined) {
    if (
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      throw new SubscriptionValidationError(
        "invalid-filter",
        "filter.bbox must be [west, south, east, north] — four finite numbers"
      );
    }
    const [west, south, east, north] = bbox as [number, number, number, number];
    if (west < -180 || west > 180 || east < -180 || east > 180) {
      throw new SubscriptionValidationError(
        "invalid-filter",
        "filter.bbox longitudes (west, east) must be within [-180, 180]"
      );
    }
    if (south < -90 || south > 90 || north < -90 || north > 90) {
      throw new SubscriptionValidationError(
        "invalid-filter",
        "filter.bbox latitudes (south, north) must be within [-90, 90]"
      );
    }
    if (west >= east) {
      throw new SubscriptionValidationError("invalid-filter", "filter.bbox requires west < east");
    }
    if (south >= north) {
      throw new SubscriptionValidationError("invalid-filter", "filter.bbox requires south < north");
    }
  }

  if (filter.types !== undefined) assertStringAllowList(filter.types, "filter.types");
  if (filter.privacyClasses !== undefined) {
    assertStringAllowList(filter.privacyClasses, "filter.privacyClasses");
  }

  const maxAgeSec: unknown = filter.maxAgeSec;
  if (maxAgeSec !== undefined) {
    if (typeof maxAgeSec !== "number" || !Number.isFinite(maxAgeSec) || maxAgeSec <= 0) {
      throw new SubscriptionValidationError(
        "invalid-filter",
        "filter.maxAgeSec must be a finite number greater than 0"
      );
    }
  }
}

/** Whether a filter narrows the journal at all (any of the source-side bounds). */
function filterIsBounded(filter: FederationFilter): boolean {
  return (
    filter.bbox !== undefined ||
    filter.types !== undefined ||
    filter.privacyClasses !== undefined ||
    filter.maxAgeSec !== undefined
  );
}

/**
 * Normalizes and validates a create/patch request. Push modes (webhook/sse)
 * require a bounded filter; webhook additionally requires a public https inbox.
 * Throws {@link SubscriptionValidationError} the route turns into 422.
 */
export function validateSubscriptionShape(input: {
  filter: FederationFilter;
  deliveryMode: DeliveryMode;
  inboxUrl: string | null;
  priorityOnly: boolean;
}): void {
  if (!DELIVERY_MODES.includes(input.deliveryMode)) {
    throw new SubscriptionValidationError(
      "invalid-delivery-mode",
      `deliveryMode must be one of ${DELIVERY_MODES.join(", ")}`
    );
  }

  // Value-level validation runs for every mode — a malformed bbox/maxAge is
  // refused whether the subscription pulls or is pushed.
  validateFilterValues(input.filter);

  const isPush = input.deliveryMode === "webhook" || input.deliveryMode === "sse";

  if (isPush && !filterIsBounded(input.filter)) {
    throw new SubscriptionValidationError(
      "over-broad-filter",
      "a webhook/sse subscription needs a bounded filter (a bbox, a types " +
        "allow-list, a privacyClasses allow-list, or a maxAgeSec bound) — an " +
        "unbounded push would firehose the whole journal",
      { ...input.filter, types: RECOMMENDED_NARROW_TYPES }
    );
  }

  if (input.deliveryMode === "webhook") {
    if (input.inboxUrl === null || input.inboxUrl.length === 0) {
      throw new SubscriptionValidationError(
        "inbox-required",
        "a webhook subscription requires an inboxUrl"
      );
    }
    assertInboxUrl(input.inboxUrl);
  } else if (input.inboxUrl !== null && input.inboxUrl.length > 0) {
    // A non-webhook mode still gets its inbox SSRF-checked if one is supplied,
    // so a later PATCH to webhook cannot smuggle a private target in unchecked.
    assertInboxUrl(input.inboxUrl);
  }
}

/** Rejects a non-public or non-https inbox target (the webhook POST egress
 *  re-guards through guardedFetch, but the target is refused up front too). */
function assertInboxUrl(inboxUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(inboxUrl);
  } catch {
    throw new SubscriptionValidationError("inbox-not-public", "inboxUrl is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new SubscriptionValidationError("inbox-not-public", "inboxUrl must be an https URL");
  }
  try {
    assertPublicUrl(inboxUrl);
  } catch {
    throw new SubscriptionValidationError(
      "inbox-not-public",
      "inboxUrl must be a public address (no loopback/private/link-local targets)"
    );
  }
}

interface SubscriptionRow {
  id: string;
  peer_id: string;
  filter: FederationFilter;
  delivery_mode: DeliveryMode;
  inbox_url: string | null;
  cursor: string;
  priority_only: boolean;
  push_failures: number;
  status: SubscriptionStatus;
  created_at: Date;
  updated_at: Date;
}

function rowToSubscription(row: SubscriptionRow): FederationSubscription {
  return {
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
}

/**
 * Creates a subscription for `peerId`. Validates the shape first (throws
 * {@link SubscriptionValidationError} on an over-broad/invalid request), then
 * inserts a fresh row at the journal-start cursor `"0.0"`.
 */
export async function createSubscription(
  sql: postgres.Sql,
  peerId: string,
  input: CreateSubscriptionInput,
  now: string
): Promise<FederationSubscription> {
  const filter = input.filter ?? {};
  const deliveryMode = input.deliveryMode ?? "pull";
  const inboxUrl = input.inboxUrl ?? null;
  const priorityOnly = input.priorityOnly ?? true;

  validateSubscriptionShape({ filter, deliveryMode, inboxUrl, priorityOnly });

  const id = globalThis.crypto.randomUUID();
  const at = new Date(now);
  const [row] = await sql<SubscriptionRow[]>`
    INSERT INTO conditions.federation_subscription
      (id, peer_id, filter, delivery_mode, inbox_url, cursor, priority_only, status,
       created_at, updated_at)
    VALUES (${id}, ${peerId}, ${sql.json(filter as never)}, ${deliveryMode}, ${inboxUrl},
            '0.0', ${priorityOnly}, 'active', ${at}, ${at})
    RETURNING *`;
  return rowToSubscription(row!);
}

/** Lists a peer's own subscriptions, newest first. */
export async function listSubscriptions(
  sql: postgres.Sql,
  peerId: string
): Promise<FederationSubscription[]> {
  const rows = await sql<SubscriptionRow[]>`
    SELECT * FROM conditions.federation_subscription
    WHERE peer_id = ${peerId}
    ORDER BY created_at DESC, id DESC`;
  return rows.map(rowToSubscription);
}

/** Loads one subscription by id, or null if it does not exist. */
export async function getSubscription(
  sql: postgres.Sql,
  id: string
): Promise<FederationSubscription | null> {
  const [row] = await sql<SubscriptionRow[]>`
    SELECT * FROM conditions.federation_subscription WHERE id = ${id}`;
  return row ? rowToSubscription(row) : null;
}

/**
 * Patches a subscription's filter/deliveryMode/inboxUrl/priorityOnly. The MERGED
 * shape is validated (so a PATCH cannot leave the row over-broad or with a bad
 * inbox), and the effective values are written. Returns the updated row, or null
 * if it does not exist. `existing` is passed so the route can enforce ownership
 * and avoid a second read.
 *
 * A PATCH also RE-ENABLES push: `status` resets to `active` and `push_failures`
 * to 0. A peer whose inbox went down (flipping the row to `push_disabled`) fixes
 * it and PATCHes — e.g. a new `inboxUrl` — to resume push without having to
 * DELETE and recreate (and re-push history). The push cursor is left untouched,
 * so resumption is exactly where delivery stalled.
 */
export async function updateSubscription(
  sql: postgres.Sql,
  existing: FederationSubscription,
  patch: UpdateSubscriptionInput,
  now: string
): Promise<FederationSubscription | null> {
  const filter = patch.filter ?? existing.filter;
  const deliveryMode = patch.deliveryMode ?? existing.deliveryMode;
  const inboxUrl = patch.inboxUrl !== undefined ? patch.inboxUrl : existing.inboxUrl;
  const priorityOnly = patch.priorityOnly ?? existing.priorityOnly;

  validateSubscriptionShape({ filter, deliveryMode, inboxUrl, priorityOnly });

  const [row] = await sql<SubscriptionRow[]>`
    UPDATE conditions.federation_subscription
    SET filter = ${sql.json(filter as never)}, delivery_mode = ${deliveryMode},
        inbox_url = ${inboxUrl}, priority_only = ${priorityOnly},
        status = 'active', push_failures = 0, updated_at = ${new Date(now)}
    WHERE id = ${existing.id}
    RETURNING *`;
  return row ? rowToSubscription(row) : null;
}

/** Deletes a subscription by id; returns whether a row was removed. */
export async function deleteSubscription(sql: postgres.Sql, id: string): Promise<boolean> {
  const rows =
    await sql`DELETE FROM conditions.federation_subscription WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
