import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { ensureInstanceKey, loadActiveKeys, type InstanceKey } from "../keys.js";
import { InMemoryNonceStore, verifyMessage } from "../http-signature.js";
import { encodeOutboxCursor, readOutbox, type OutboxCursor, type OutboxEntry } from "../outbox.js";
import {
  createSubscription,
  getSubscription,
  type FederationSubscription,
} from "../subscriptions.js";
import { deliverWebhook, PUSH_FAILURE_THRESHOLD } from "../push.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let signingKey: InstanceKey;

const NOW = "2026-07-13T12:00:00.000Z";
const INBOX_URL = "https://peer.example.org/inbox";
const PARTOF = "https://conditions.example.org/peer/outbox";
const PEER_ID = "oc-neighbor";

interface CapturedPush {
  headers: Record<string, string>;
  body: Buffer;
  items: OutboxEntry[];
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
      orderedItems: OutboxEntry[];
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

/** The wire composite cursor of a journalled object's (latest) entry. */
async function cursorOfObject(objectId: string): Promise<string> {
  const [row] = await sql<{ txid: string; seq: string }[]>`
    SELECT txid::text AS txid, seq::text AS seq
    FROM conditions.federation_outbox
    WHERE object_id = ${objectId}
    ORDER BY txid DESC, seq DESC LIMIT 1`;
  return encodeOutboxCursor({ txid: row!.txid, seq: Number(row!.seq) });
}

async function insertEvent(id: string, opts: { type?: string; lon?: number } = {}): Promise<void> {
  const geometry = { type: "Point", coordinates: [opts.lon ?? 5.1, 52.1] };
  await sql`
    INSERT INTO conditions.observations
      (id, source, source_format, domain, kind, type, category, severity, severity_source,
       headline, status, geom, origin, data_updated_at, fetched_at, privacy_class)
    VALUES (${id}, 'push-test', 'datex2', 'roads', 'event', ${opts.type ?? "road_closure"},
       'incident', 'high', 'declared', ${id}, 'active',
       ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326),
       ${sql.json({ kind: "feed", attribution: { provider: "Auth", license: "CC-BY-4.0" } } as never)},
       '2026-07-13T10:00:00Z', '2026-07-13T10:00:00Z', 'authoritative')`;
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
      filter: { bbox: opts.bbox, permissiveOnly: false },
    },
    NOW
  );
  const start = encodeOutboxCursor(await frontier());
  await sql`UPDATE conditions.federation_subscription SET cursor = ${start} WHERE id = ${sub.id}`;
  return (await getSubscription(sql, sub.id))!;
}

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/conditions_test`;
  sql = postgres(url, { max: 4 });
  await runMigrations(url);
  await ensureInstanceKey(sql, NOW);
  [signingKey] = await loadActiveKeys(sql, NOW);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("deliverWebhook — signed page, cursor advance, priority gating", () => {
  it("POSTs a signed page and advances the cursor to the page frontier on 2xx", async () => {
    const bbox: [number, number, number, number] = [10.0, 51.0, 11.0, 53.0];
    const sub = await webhookSubFromNow({ priorityOnly: true, bbox });
    await insertEvent("push-a", { type: "road_closure", lon: 10.5 });
    await insertEvent("push-b", { type: "accident", lon: 10.6 });

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
    expect(captured[0]!.items.map((e) => e.objectId)).toEqual(["push-a", "push-b"]);

    const after = await getSubscription(sql, sub.id);
    expect(after!.cursor).toBe(captured[0]!.cursor);
    expect(after!.pushFailures).toBe(0);
  }, 30_000);

  it("under priorityOnly, a non-priority matching event is NOT pushed and the cursor never advances past it", async () => {
    // The exact skip the review caught: types allows BOTH classes, priorityOnly
    // restricts the push CHANNEL to closures. A trailing non-priority matching
    // event must NOT be pushed AND the push cursor must stop on the priority
    // event, never jumping past the non-priority one (whose completeness is pull).
    const bbox: [number, number, number, number] = [12.0, 51.0, 13.0, 53.0];
    const filter = { bbox, types: ["road_closure", "roadworks"], permissiveOnly: false };
    const sub = await createSubscription(
      sql,
      PEER_ID,
      { deliveryMode: "webhook", inboxUrl: INBOX_URL, priorityOnly: true, filter },
      NOW
    );
    const start = encodeOutboxCursor(await frontier());
    await sql`UPDATE conditions.federation_subscription SET cursor = ${start} WHERE id = ${sub.id}`;
    const fresh = (await getSubscription(sql, sub.id))!;

    // X (priority) FIRST, then Y (non-priority) — Y trails X in the journal.
    await insertEvent("pri-closure", { type: "road_closure", lon: 12.4 });
    await insertEvent("pri-works", { type: "roadworks", lon: 12.5 });
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
    expect(captured[0]!.items.map((e) => e.objectId)).toEqual(["pri-closure"]);

    // The push cursor stops ON the closure — NOT past the trailing roadwork.
    const after = await getSubscription(sql, sub.id);
    expect(after!.cursor).toBe(closureCursor);

    // Completeness: the peer's OWN pull (no priorityClasses) from its start cursor
    // returns BOTH — the non-priority roadwork is never lost.
    const pull = await readOutbox(sql, { after: start, filter, now: NOW, limit: 500 });
    expect(pull.orderedItems.map((e) => e.objectId)).toEqual(["pri-closure", "pri-works"]);
  }, 30_000);

  it("does not starve behind a long run of non-priority events (SQL-level restriction)", async () => {
    const bbox: [number, number, number, number] = [22.0, 51.0, 23.0, 53.0];
    const filter = { bbox, types: ["road_closure", "roadworks"], permissiveOnly: false };
    const sub = await createSubscription(
      sql,
      PEER_ID,
      { deliveryMode: "webhook", inboxUrl: INBOX_URL, priorityOnly: true, filter },
      NOW
    );
    const start = encodeOutboxCursor(await frontier());
    await sql`UPDATE conditions.federation_subscription SET cursor = ${start} WHERE id = ${sub.id}`;
    const fresh = (await getSubscription(sql, sub.id))!;

    // Three non-priority events then one priority, delivered with limit=2 — a
    // post-filter approach would starve (scan 2 roadworks, keep none, re-scan);
    // the SQL restriction reaches the closure regardless of the limit.
    await insertEvent("starve-w1", { type: "roadworks", lon: 22.1 });
    await insertEvent("starve-w2", { type: "roadworks", lon: 22.2 });
    await insertEvent("starve-w3", { type: "roadworks", lon: 22.3 });
    await insertEvent("starve-closure", { type: "road_closure", lon: 22.4 });

    const { fetchImpl, captured } = mockInbox([200]);
    const outcome = await deliverWebhook(sql, fresh, {
      signingKey,
      fetchImpl,
      partOf: PARTOF,
      now: NOW,
      limit: 2,
    });
    expect(outcome.status).toBe("delivered");
    expect(captured[0]!.items.map((e) => e.objectId)).toEqual(["starve-closure"]);
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
    const filter = { bbox, permissiveOnly: false };
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
    const pushed = first.captured[0]!.items.map((e) => e.objectId);
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
    const pulled = pull.orderedItems.map((e) => e.objectId);
    expect(pulled).toEqual(["share-c", "share-d"]);

    // The union of pushed + pulled = every matching event, each exactly once.
    const union = [...pushed, ...pulled];
    expect(union).toEqual(["share-a", "share-b", "share-c", "share-d"]);
    expect(new Set(union).size).toBe(union.length);

    // And the pull re-run from the ORIGINAL start proves the same total set.
    const all = await readOutbox(sql, { after: startCursor, filter, now: NOW, limit: 500 });
    expect(all.orderedItems.map((e) => e.objectId)).toEqual([
      "share-a",
      "share-b",
      "share-c",
      "share-d",
    ]);
  }, 30_000);
});

describe("deliverWebhook — priorityOnly push (priority) + peer pull (all) = every event once", () => {
  it("a dropped priority push re-pushes; the peer's independent pull covers everything", async () => {
    const bbox: [number, number, number, number] = [24.0, 51.0, 25.0, 53.0];
    const filter = { bbox, types: ["road_closure", "roadworks"], permissiveOnly: false };
    const sub = await createSubscription(
      sql,
      PEER_ID,
      { deliveryMode: "webhook", inboxUrl: INBOX_URL, priorityOnly: true, filter },
      NOW
    );
    const startCursor = encodeOutboxCursor(await frontier());
    await sql`UPDATE conditions.federation_subscription SET cursor = ${startCursor} WHERE id = ${sub.id}`;
    const fresh = (await getSubscription(sql, sub.id))!;

    // Priority and non-priority matching events, interleaved.
    await insertEvent("mix-p1", { type: "road_closure", lon: 24.1 });
    await insertEvent("mix-n1", { type: "roadworks", lon: 24.2 });
    await insertEvent("mix-p2", { type: "road_closure", lon: 24.3 });
    await insertEvent("mix-n2", { type: "roadworks", lon: 24.4 });

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
    expect(first.captured[0]!.items.map((e) => e.objectId)).toEqual(["mix-p1"]);
    const pushedPriority = [...first.captured[0]!.items.map((e) => e.objectId)];

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
    expect(second.captured[0]!.items.map((e) => e.objectId)).toEqual(["mix-p2"]);
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
    expect(retry.captured[0]!.items.map((e) => e.objectId)).toEqual(["mix-p2"]);

    // COMPLETENESS: the peer's OWN pull (independent cursor, NOT priorityOnly)
    // returns every matching event — priority AND non-priority — exactly once.
    const pull = await readOutbox(sql, { after: startCursor, filter, now: NOW, limit: 500 });
    const pulled = pull.orderedItems.map((e) => e.objectId);
    expect(pulled).toEqual(["mix-p1", "mix-n1", "mix-p2", "mix-n2"]);

    // The push channel only ever carried priority events; the deduped union of
    // push(priority) and pull(all) is exactly every matching event once.
    const union = new Set([...pushedPriority, ...pulled]);
    expect([...union].sort()).toEqual(["mix-n1", "mix-n2", "mix-p1", "mix-p2"]);
    for (const id of pushedPriority) expect(pulled).toContain(id); // push ⊆ pull
  }, 30_000);
});
