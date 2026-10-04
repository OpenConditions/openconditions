import { tombstoneRecords } from "@openconditions/storage";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryNonceStore, verifyMessage } from "../http-signature.js";
import { ensureInstanceKey, type InstanceKey, loadActiveKeys } from "../keys.js";
import { encodeOutboxCursor, type OutboxCursor, readOutbox } from "../outbox.js";
import { deliverWebhook, PUSH_FAILURE_THRESHOLD } from "../push.js";
import type { RecordOutboxEntry } from "../record-filter.js";
import {
  createSubscription,
  type FederationSubscription,
  getSubscription,
  updateSubscription,
} from "../subscriptions.js";
import {
  incidentDraft,
  roadworksDraft,
  situationId,
  startDatabase,
  writeCtx,
  writeOwn,
} from "./record-fixtures.integration.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let db: Awaited<ReturnType<typeof startDatabase>>;
let sql: postgres.Sql;
let signingKey: InstanceKey;

const NOW = "2026-07-13T12:00:00.000Z";
const INBOX_URL = "https://peer.example.org/inbox";
const PARTOF = "https://conditions.example.org/peer/outbox";
const PEER_ID = "oc-neighbor";

interface CapturedPush {
  headers: Record<string, string>;
  body: Buffer;
  items: RecordOutboxEntry[];
  cursor: string;
  signatureOk: boolean;
}

/** A mock peer inbox: verifies the RFC-9421 signature over the received bytes,
 *  records the page, and returns the queued HTTP status. */
function mockInbox(statuses: number[]): {
  fetchImpl: typeof fetch;
  captured: CapturedPush[];
} {
  const captured: CapturedPush[] = [];
  let call = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = Buffer.from((init?.body as Buffer) ?? Buffer.alloc(0));
    const headers = init?.headers as Record<string, string>;
    const verified = await verifyMessage({
      method: "POST",
      url: INBOX_URL,
      headers,
      body,
      resolvePublicKey: async (keyId) => (keyId === signingKey.keyId ? signingKey.publicKey : null),
      nonceStore: new InMemoryNonceStore(),
    });
    const page = JSON.parse(body.toString("utf8")) as {
      orderedItems: RecordOutboxEntry[];
      highWaterMark: string;
    };
    captured.push({
      headers,
      body,
      items: page.orderedItems,
      cursor: page.highWaterMark,
      signatureOk: verified.ok,
    });
    const status = statuses[call] ?? statuses[statuses.length - 1] ?? 200;
    call += 1;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

async function frontier(): Promise<OutboxCursor> {
  const [row] = await sql<{ txid: string; seq: string }[]>`
    SELECT txid::text AS txid, seq::text AS seq
    FROM conditions.federation_outbox
    ORDER BY txid DESC, seq DESC LIMIT 1`;
  return row ? { txid: row.txid, seq: Number(row.seq) } : { txid: "0", seq: 0 };
}

/** The wire composite cursor of a journalled situation's (latest) entry. */
async function cursorOfObject(local: string): Promise<string> {
  const [row] = await sql<{ txid: string; seq: string }[]>`
    SELECT txid::text AS txid, seq::text AS seq
    FROM conditions.federation_outbox o
    WHERE record_id = ${situationId(local)}
    ORDER BY o.txid DESC, o.seq DESC LIMIT 1`;
  return encodeOutboxCursor({ txid: row!.txid, seq: Number(row!.seq) });
}

/** The local part of an entry's record id, the name a test wrote it under. */
const localOf = (entry: RecordOutboxEntry) =>
  entry.recordId.slice(entry.recordId.lastIndexOf(":") + 1);

/**
 * Writes this instance's own situation: an incident (a priority entry) by
 * default, or roadworks whose lane closure lies in a later phase (not one).
 */
async function insertEvent(
  local: string,
  opts: { kind?: "incident" | "roadworks"; lon?: number } = {},
): Promise<void> {
  const over = { lon: opts.lon ?? 5.1 };
  const draft =
    (opts.kind ?? "incident") === "incident"
      ? incidentDraft(local, over)
      : roadworksDraft(local, over);
  await writeOwn(sql, draft);
}

/** Creates a webhook subscription whose cursor starts at the current frontier
 *  (so only this test's later inserts are in scope). */
async function webhookSubFromNow(opts: {
  priorityOnly: boolean;
  bbox: [number, number, number, number];
}): Promise<FederationSubscription> {
  const sub = await createSubscription(
    sql,
    PEER_ID,
    {
      deliveryMode: "webhook",
      inboxUrl: INBOX_URL,
      priorityOnly: opts.priorityOnly,
      filter: { bbox: opts.bbox },
    },
    NOW,
  );
  const start = encodeOutboxCursor(await frontier());
  await sql`UPDATE conditions.federation_subscription SET cursor = ${start} WHERE id = ${sub.id}`;
  return (await getSubscription(sql, sub.id))!;
}

beforeAll(async () => {
  db = await startDatabase();
  sql = db.sql;
  await ensureInstanceKey(sql, NOW);
  [signingKey] = await loadActiveKeys(sql, NOW);
}, 120_000);

afterAll(async () => {
  await db?.close();
}, 30_000);

describe("deliverWebhook — signed page, cursor advance, priority gating", () => {
  it("POSTs a signed page and advances the cursor to the page frontier on 2xx", async () => {
    const bbox: [number, number, number, number] = [10.0, 51.0, 11.0, 53.0];
    const sub = await webhookSubFromNow({ priorityOnly: true, bbox });
    await insertEvent("push-a", { kind: "incident", lon: 10.5 });
    await insertEvent("push-b", { kind: "incident", lon: 10.6 });

    const { fetchImpl, captured } = mockInbox([200]);
    const outcome = await deliverWebhook(sql, sub, {
      signingKey,
      fetchImpl,
      partOf: PARTOF,
      now: NOW,
    });

    expect(outcome.status).toBe("delivered");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.signatureOk).toBe(true);
    expect(captured[0]!.items.map(localOf)).toEqual(["push-a", "push-b"]);

    const after = await getSubscription(sql, sub.id);
    expect(after!.cursor).toBe(captured[0]!.cursor);
    expect(after!.pushFailures).toBe(0);
  }, 30_000);

  it("under priorityOnly, a non-priority matching event is NOT pushed and the cursor never advances past it", async () => {
    // The exact skip the review caught: the filter's kinds allow BOTH, priorityOnly
    // restricts the push CHANNEL to priority entries. A trailing non-priority matching
    // event must NOT be pushed AND the push cursor must stop on the priority
    // event, never jumping past the non-priority one (whose completeness is pull).
    const bbox: [number, number, number, number] = [12.0, 51.0, 13.0, 53.0];
    const filter = { bbox, kinds: ["incident", "roadworks"] };
    const sub = await createSubscription(
      sql,
      PEER_ID,
      { deliveryMode: "webhook", inboxUrl: INBOX_URL, priorityOnly: true, filter },
      NOW,
    );
    const start = encodeOutboxCursor(await frontier());
    await sql`UPDATE conditions.federation_subscription SET cursor = ${start} WHERE id = ${sub.id}`;
    const fresh = (await getSubscription(sql, sub.id))!;

    // X (priority) FIRST, then Y (non-priority) — Y trails X in the journal.
    await insertEvent("pri-closure", { kind: "incident", lon: 12.4 });
    await insertEvent("pri-works", { kind: "roadworks", lon: 12.5 });
    const closureCursor = await cursorOfObject("pri-closure");

    const { fetchImpl, captured } = mockInbox([200]);
    const outcome = await deliverWebhook(sql, fresh, {
      signingKey,
      fetchImpl,
      partOf: PARTOF,
      now: NOW,
    });

    // Only the closure is pushed; the roadwork is NOT.
    expect(outcome.status).toBe("delivered");
    expect(captured[0]!.items.map(localOf)).toEqual(["pri-closure"]);

    // The push cursor stops ON the closure — NOT past the trailing roadwork.
    const after = await getSubscription(sql, sub.id);
    expect(after!.cursor).toBe(closureCursor);

    // Completeness: the peer's OWN pull (not priorityOnly) from its start cursor
    // returns BOTH — the non-priority roadwork is never lost.
    const pull = await readOutbox(sql, { after: start, filter, now: NOW, limit: 500 });
    expect(pull.orderedItems.map(localOf)).toEqual(["pri-closure", "pri-works"]);
  }, 30_000);

  it("does not starve behind a long run of non-priority events (SQL-level restriction)", async () => {
    const bbox: [number, number, number, number] = [22.0, 51.0, 23.0, 53.0];
    const filter = { bbox, kinds: ["incident", "roadworks"] };
    const sub = await createSubscription(
      sql,
      PEER_ID,
      { deliveryMode: "webhook", inboxUrl: INBOX_URL, priorityOnly: true, filter },
      NOW,
    );
    const start = encodeOutboxCursor(await frontier());
    await sql`UPDATE conditions.federation_subscription SET cursor = ${start} WHERE id = ${sub.id}`;
    const fresh = (await getSubscription(sql, sub.id))!;

    // Three non-priority events then one priority, delivered with limit=2 — a
    // post-filter approach would starve (scan 2 roadworks, keep none, re-scan);
    // the SQL restriction reaches the closure regardless of the limit.
    await insertEvent("starve-w1", { kind: "roadworks", lon: 22.1 });
    await insertEvent("starve-w2", { kind: "roadworks", lon: 22.2 });
    await insertEvent("starve-w3", { kind: "roadworks", lon: 22.3 });
    await insertEvent("starve-closure", { kind: "incident", lon: 22.4 });

    const { fetchImpl, captured } = mockInbox([200]);
    const outcome = await deliverWebhook(sql, fresh, {
      signingKey,
      fetchImpl,
      partOf: PARTOF,
      now: NOW,
      limit: 2,
    });
    expect(outcome.status).toBe("delivered");
    expect(captured[0]!.items.map(localOf)).toEqual(["starve-closure"]);
  }, 30_000);

  it("under priorityOnly, still pushes the retraction of a non-priority record", async () => {
    const sub = await webhookSubFromNow({ priorityOnly: true, bbox: [26.0, 51.0, 27.0, 53.0] });
    await insertEvent("retract-works", { kind: "roadworks", lon: 26.5 });
    await sql.begin((tx) =>
      tombstoneRecords(tx, "situation", [situationId("retract-works")], "withdrawn", writeCtx()),
    );

    const { fetchImpl, captured } = mockInbox([200]);
    const outcome = await deliverWebhook(sql, sub, {
      signingKey,
      fetchImpl,
      partOf: PARTOF,
      now: NOW,
    });
    expect(outcome.status).toBe("delivered");
    expect(captured[0]!.items).toEqual([
      expect.objectContaining({
        recordId: situationId("retract-works"),
        operation: "delete",
        reason: "withdrawn",
      }),
    ]);
  }, 30_000);
});

describe("deliverWebhook — priorityRestricted self-describing marker", () => {
  it("stamps priorityRestricted:true on a priorityOnly pushed page", async () => {
    const bbox: [number, number, number, number] = [40.0, 51.0, 41.0, 53.0];
    const sub = await webhookSubFromNow({ priorityOnly: true, bbox });
    await insertEvent("mark-pri", { kind: "incident", lon: 40.5 });

    const { fetchImpl, captured } = mockInbox([200]);
    await deliverWebhook(sql, sub, { signingKey, fetchImpl, partOf: PARTOF, now: NOW });

    const page = JSON.parse(captured[0]!.body.toString("utf8")) as { priorityRestricted?: boolean };
    expect(page.priorityRestricted).toBe(true);
  }, 30_000);

  it("does NOT set priorityRestricted on a full-fidelity (priorityOnly:false) push", async () => {
    const bbox: [number, number, number, number] = [42.0, 51.0, 43.0, 53.0];
    const sub = await webhookSubFromNow({ priorityOnly: false, bbox });
    await insertEvent("mark-full", { kind: "incident", lon: 42.5 });

    const { fetchImpl, captured } = mockInbox([200]);
    await deliverWebhook(sql, sub, { signingKey, fetchImpl, partOf: PARTOF, now: NOW });

    const page = JSON.parse(captured[0]!.body.toString("utf8")) as { priorityRestricted?: boolean };
    expect(page.priorityRestricted ?? false).toBe(false);
  }, 30_000);

  it("the pull /peer/outbox page NEVER sets priorityRestricted (it is complete)", async () => {
    const bbox: [number, number, number, number] = [44.0, 51.0, 45.0, 53.0];
    const filter = { bbox };
    const start = encodeOutboxCursor(await frontier());
    await insertEvent("mark-pull", { kind: "incident", lon: 44.5 });

    const pull = await readOutbox(sql, { after: start, filter, now: NOW, limit: 500 });
    expect(pull.orderedItems.map(localOf)).toContain("mark-pull");
    expect((pull as { priorityRestricted?: boolean }).priorityRestricted).toBeUndefined();
  }, 30_000);
});

describe("deliverWebhook — failure disables push after the threshold", () => {
  it("increments push_failures on 5xx and flips to push_disabled at the threshold", async () => {
    const bbox: [number, number, number, number] = [14.0, 51.0, 15.0, 53.0];
    let sub = await webhookSubFromNow({ priorityOnly: false, bbox });
    await insertEvent("fail-a", { lon: 14.5 });

    const cursorBefore = sub.cursor;
    const { fetchImpl } = mockInbox([500]);
    for (let i = 1; i <= PUSH_FAILURE_THRESHOLD; i++) {
      const outcome = await deliverWebhook(sql, sub, {
        signingKey,
        fetchImpl,
        partOf: PARTOF,
        now: NOW,
      });
      sub = (await getSubscription(sql, sub.id))!;
      expect(sub.pushFailures).toBe(i);
      // Cursor never advances on failure — the peer's pull catch-up stays gap-free.
      expect(sub.cursor).toBe(cursorBefore);
      if (i < PUSH_FAILURE_THRESHOLD) {
        expect(outcome.status).toBe("failed");
        expect(sub.status).toBe("active");
      } else {
        expect(outcome.status).toBe("disabled");
        expect(sub.status).toBe("push_disabled");
      }
    }
  }, 30_000);
});

describe("deliverWebhook — priorityOnly=false is full-fidelity; push and pull share the cursor", () => {
  it("a dropped push falls back to a pull catch-up with no gap and no double-delivery", async () => {
    const bbox: [number, number, number, number] = [16.0, 51.0, 17.0, 53.0];
    const filter = { bbox };
    const sub = await webhookSubFromNow({ priorityOnly: false, bbox });
    const startCursor = sub.cursor;

    // Four matching events, in order.
    await insertEvent("share-a", { lon: 16.1 });
    await insertEvent("share-b", { lon: 16.2 });
    await insertEvent("share-c", { lon: 16.3 });
    await insertEvent("share-d", { lon: 16.4 });

    // First push (limit 2) is ACKED: the peer receives [a,b] and stores the
    // page frontier as the last cursor it saw.
    const first = mockInbox([200]);
    const out1 = await deliverWebhook(sql, sub, {
      signingKey,
      fetchImpl: first.fetchImpl,
      partOf: PARTOF,
      now: NOW,
      limit: 2,
    });
    expect(out1.status).toBe("delivered");
    const pushed = first.captured[0]!.items.map(localOf);
    const peerLastCursor = first.captured[0]!.cursor; // the cursor the peer saw
    expect(pushed).toEqual(["share-a", "share-b"]);

    // Second push is DROPPED (inbox 5xx): the publisher does NOT advance the
    // cursor, so nothing is acked past [a,b].
    const sub2 = (await getSubscription(sql, sub.id))!;
    const second = mockInbox([503]);
    const out2 = await deliverWebhook(sql, sub2, {
      signingKey,
      fetchImpl: second.fetchImpl,
      partOf: PARTOF,
      now: NOW,
      limit: 2,
    });
    expect(out2.status).toBe("failed");
    const afterDrop = await getSubscription(sql, sub.id);
    expect(afterDrop!.cursor).toBe(peerLastCursor); // unchanged past the acked page

    // FALLBACK: the peer pulls /peer/outbox from the last cursor it saw. It gets
    // EXACTLY the events it missed, in order — no gap, no double-delivery.
    const pull = await readOutbox(sql, { after: peerLastCursor, filter, now: NOW, limit: 500 });
    const pulled = pull.orderedItems.map(localOf);
    expect(pulled).toEqual(["share-c", "share-d"]);

    // The union of pushed + pulled = every matching event, each exactly once.
    const union = [...pushed, ...pulled];
    expect(union).toEqual(["share-a", "share-b", "share-c", "share-d"]);
    expect(new Set(union).size).toBe(union.length);

    // And the pull re-run from the ORIGINAL start proves the same total set.
    const all = await readOutbox(sql, { after: startCursor, filter, now: NOW, limit: 500 });
    expect(all.orderedItems.map(localOf)).toEqual(["share-a", "share-b", "share-c", "share-d"]);
  }, 30_000);
});

describe("deliverWebhook — priorityOnly push (priority) + peer pull (all) = every event once", () => {
  it("a dropped priority push re-pushes; the peer's independent pull covers everything", async () => {
    const bbox: [number, number, number, number] = [24.0, 51.0, 25.0, 53.0];
    const filter = { bbox, kinds: ["incident", "roadworks"] };
    const sub = await createSubscription(
      sql,
      PEER_ID,
      { deliveryMode: "webhook", inboxUrl: INBOX_URL, priorityOnly: true, filter },
      NOW,
    );
    const startCursor = encodeOutboxCursor(await frontier());
    await sql`UPDATE conditions.federation_subscription SET cursor = ${startCursor} WHERE id = ${sub.id}`;
    const fresh = (await getSubscription(sql, sub.id))!;

    // Priority and non-priority matching events, interleaved.
    await insertEvent("mix-p1", { kind: "incident", lon: 24.1 });
    await insertEvent("mix-n1", { kind: "roadworks", lon: 24.2 });
    await insertEvent("mix-p2", { kind: "incident", lon: 24.3 });
    await insertEvent("mix-n2", { kind: "roadworks", lon: 24.4 });

    // First priority push (limit 1 priority) is ACKED → P1 delivered, cursor→P1.
    const first = mockInbox([200]);
    const out1 = await deliverWebhook(sql, fresh, {
      signingKey,
      fetchImpl: first.fetchImpl,
      partOf: PARTOF,
      now: NOW,
      limit: 1,
    });
    expect(out1.status).toBe("delivered");
    expect(first.captured[0]!.items.map(localOf)).toEqual(["mix-p1"]);
    const pushedPriority = [...first.captured[0]!.items.map(localOf)];

    // Second priority push (P2) is DROPPED → cursor NOT advanced past P1.
    const afterAck = (await getSubscription(sql, sub.id))!;
    const cursorAfterAck = afterAck.cursor;
    const second = mockInbox([500]);
    const out2 = await deliverWebhook(sql, afterAck, {
      signingKey,
      fetchImpl: second.fetchImpl,
      partOf: PARTOF,
      now: NOW,
      limit: 1,
    });
    expect(out2.status).toBe("failed");
    expect(second.captured[0]!.items.map(localOf)).toEqual(["mix-p2"]);
    const afterDrop = (await getSubscription(sql, sub.id))!;
    expect(afterDrop.cursor).toBe(cursorAfterAck); // priority cursor unadvanced

    // A re-push from the unadvanced cursor re-sends P2 (idempotent) — no priority
    // event is lost by the drop.
    const retry = mockInbox([200]);
    const out3 = await deliverWebhook(sql, afterDrop, {
      signingKey,
      fetchImpl: retry.fetchImpl,
      partOf: PARTOF,
      now: NOW,
      limit: 1,
    });
    expect(out3.status).toBe("delivered");
    expect(retry.captured[0]!.items.map(localOf)).toEqual(["mix-p2"]);

    // COMPLETENESS: the peer's OWN pull (independent cursor, NOT priorityOnly)
    // returns every matching event — priority AND non-priority — exactly once.
    const pull = await readOutbox(sql, { after: startCursor, filter, now: NOW, limit: 500 });
    const pulled = pull.orderedItems.map(localOf);
    expect(pulled).toEqual(["mix-p1", "mix-n1", "mix-p2", "mix-n2"]);

    // The push channel only ever carried priority events; the deduped union of
    // push(priority) and pull(all) is exactly every matching event once.
    const union = new Set([...pushedPriority, ...pulled]);
    expect([...union].sort()).toEqual(["mix-n1", "mix-n2", "mix-p1", "mix-p2"]);
    for (const id of pushedPriority) expect(pulled).toContain(id); // push ⊆ pull
  }, 30_000);
});

describe("subscription edits during delivery", () => {
  it.each([200, 503])(
    "discards an obsolete %i completion and tries the repaired inbox",
    async (status) => {
      let sub = await webhookSubFromNow({ priorityOnly: true, bbox: [10, 40, 12, 60] });
      await insertEvent(`repair-${status}`, { lon: 10.5 });
      await sql`UPDATE conditions.federation_subscription SET push_failures = 4 WHERE id = ${sub.id}`;
      sub = (await getSubscription(sql, sub.id))!;
      const started = deferred<void>();
      const response = deferred<Response>();
      const pending = deliverWebhook(sql, sub, {
        signingKey,
        partOf: PARTOF,
        now: NOW,
        fetchImpl: async () => {
          started.resolve();
          return response.promise;
        },
      });
      await started.promise;
      const repaired = await updateSubscription(
        sql,
        sub,
        { inboxUrl: "https://repaired.example.org/inbox" },
        "2026-07-13T12:01:00Z",
      );
      response.resolve(new Response(null, { status }));
      expect(await pending).toEqual({ status: "obsolete" });
      expect(await getSubscription(sql, sub.id)).toEqual(repaired);
      const destinations: string[] = [];
      const outcome = await deliverWebhook(sql, repaired!, {
        signingKey,
        partOf: PARTOF,
        now: NOW,
        fetchImpl: async (url) => {
          destinations.push(String(url));
          return new Response(null, { status: 200 });
        },
      });
      expect(outcome.status).toBe("delivered");
      expect(destinations).toEqual(["https://repaired.example.org/inbox"]);
    },
  );

  it("preserves disjoint concurrent edits and rejects stale empty-scan advancement", async () => {
    const sub = await webhookSubFromNow({ priorityOnly: true, bbox: [10, 40, 12, 60] });
    await insertEvent("empty-stale", { lon: 20 });
    await Promise.all([
      updateSubscription(sql, sub, { inboxUrl: "https://repaired.example.org/inbox" }, NOW),
      updateSubscription(sql, sub, { priorityOnly: false }, NOW),
    ]);
    const current = (await getSubscription(sql, sub.id))!;
    expect(current).toMatchObject({
      inboxUrl: "https://repaired.example.org/inbox",
      priorityOnly: false,
      revision: sub.revision + 2,
    });
    const outcome = await deliverWebhook(sql, sub, {
      signingKey,
      partOf: PARTOF,
      now: NOW,
      fetchImpl: async () => {
        throw new Error("empty scan must not post");
      },
    });
    expect(outcome.status).toBe("obsolete");
    expect(await getSubscription(sql, sub.id)).toEqual(current);
  });
});
