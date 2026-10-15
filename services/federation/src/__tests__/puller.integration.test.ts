/**
 * The pull of a peer against a peer that misbehaves: every page must pass
 * what a pushed page passes (the peer's pin and signature, its block, the
 * admission of each record) and stay within what a push may cost (entries,
 * bytes, rate, time). The peer is a fake that serves pages signed with a key
 * the peer record pins.
 */
import { runMigrations } from "@openconditions/core/server";
import {
  blockPeer,
  createInMemoryRateLimiter,
  generateInstanceKey,
  InMemoryNonceStore,
  type InstanceKey,
  type PeerRecord,
  signMessage,
  storePeerVersions,
  unblockPeer,
} from "@openconditions/federation";
import { schemaVersions } from "@openconditions/model";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PULL_PAGE_LIMIT, type PullContext, pullPeer } from "../puller.js";
import { peerSituation, registry } from "./record-fixtures.js";

const PEER = "peer.example.org";
const LOCAL = "local.example.org";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;
let peerKey: InstanceKey;
let localKey: InstanceKey;
let stranger: InstanceKey;

const peer = (): PeerRecord & { pull: { filter: Record<string, never> } } => ({
  instanceId: PEER,
  actorUrl: `https://${PEER}/.well-known/openconditions/actor.json`,
  trustTier: 1,
  pinnedKeys: [peerKey.keyId],
  pull: { filter: {} },
});

type Rec = Record<string, unknown>;

/** A journal entry of the peer's record at `txid.seq`. */
const entry = (record: Rec, txid: number, seq: number) => ({
  seq,
  txid: String(txid),
  operation: "update",
  recordClass: record["class"],
  recordId: record["id"],
  canonicalId: record["canonicalId"],
  kind: record["kind"],
  domain: record["domain"],
  createdAt: record["recordedAt"],
  record,
});

const pageOf = (items: unknown[], highWaterMark: string, more: Rec = {}) => ({
  type: "OrderedCollectionPage",
  partOf: `https://${PEER}/peer/outbox`,
  highWaterMark,
  orderedItems: items,
  ...more,
});

/** A response as the peer signs one, with `key`. */
async function signed(body: Buffer, key = peerKey, status = 200): Promise<Response> {
  const s = await signMessage({
    method: "GET",
    url: `https://${PEER}/peer/outbox`,
    headers: { "content-type": "application/activity+json" },
    body,
    keyId: key.keyId,
    privateKey: key.privateKey,
    isResponse: true,
    status,
  });
  return new Response(new Uint8Array(body), { status, headers: s.headers });
}

/** A peer that answers each request with the next of `answers`, recording the URLs asked. */
function fakePeer(answers: (() => Promise<Response>)[]) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    asked.push(String(input));
    const next = answers.shift();
    if (next === undefined) throw new Error("no more answers");
    return next();
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function ctx(fetchImpl: typeof fetch, over: Partial<PullContext> = {}): PullContext {
  return {
    registry,
    localInstanceId: LOCAL,
    signingKey: localKey,
    fetchImpl,
    nonceStore: new InMemoryNonceStore(),
    rateLimiter: createInMemoryRateLimiter(),
    now: () => new Date().toISOString(),
    ...over,
  };
}

const landed = async () =>
  (await sql<{ id: string }[]>`SELECT id FROM conditions.situation ORDER BY id`).map((r) =>
    r.id.slice(r.id.lastIndexOf(":") + 1),
  );

const cursor = async () =>
  (
    await sql<{ cursor: string }[]>`
      SELECT cursor FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${PEER}`
  )[0]?.cursor;

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
  await runMigrations(url);
  sql = postgres(url, { max: 4, onnotice: () => {} });
  const now = new Date().toISOString();
  peerKey = await generateInstanceKey(now);
  localKey = await generateInstanceKey(now);
  stranger = await generateInstanceKey(now);
  await storePeerVersions(sql, PEER, schemaVersions(registry), now);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

beforeEach(async () => {
  await sql`TRUNCATE conditions.situation, conditions.federation_peer_cursor,
    conditions.federation_peer_health, conditions.federation_source_receipt CASCADE`;
});

describe("pulling a peer", () => {
  it("lands a signed page through the inbox and advances its cursor", async () => {
    const { fetchImpl, asked } = fakePeer([
      async () => signed(json(pageOf([entry(peerSituation(PEER, "ok-1"), 10, 1)], "10.1"))),
    ]);
    const result = await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(result).toMatchObject({ pages: 1, accepted: 1, cursor: "10.1" });
    expect(result.error).toBeUndefined();
    expect(await landed()).toEqual(["ok-1"]);
    expect(await cursor()).toBe("10.1");
    expect(asked[0]).toContain(`limit=${PULL_PAGE_LIMIT}`);
  });

  it("asks nothing of a peer this instance blocked", async () => {
    await blockPeer(sql, { peerId: PEER, createdBy: "test", now: new Date().toISOString() });
    try {
      const { fetchImpl, asked } = fakePeer([]);
      expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
        pages: 0,
        error: "the peer is blocked here",
      });
      expect(asked).toEqual([]);
    } finally {
      await unblockPeer(sql, PEER);
    }
  });

  it("refuses a page signed by a key the peer record does not pin", async () => {
    const page = json(pageOf([entry(peerSituation(PEER, "forged"), 10, 1)], "10.1"));
    const { fetchImpl } = fakePeer([async () => signed(page, stranger)]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
      pages: 0,
      error: "the page does not carry the peer's signature",
    });
    expect(await landed()).toEqual([]);
  });

  it("admits each record as a pushed one: another instance's record is refused", async () => {
    const relayed = peerSituation("third.example.org", "relayed");
    const { fetchImpl } = fakePeer([
      async () => signed(json(pageOf([entry(relayed, 10, 1)], "10.1"))),
    ]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ accepted: 0, skipped: 1 });
    expect(await landed()).toEqual([]);
  });

  it("refuses a page larger than a pushed page may be, unread past the cap", async () => {
    const huge = Buffer.alloc(2 * 1024 * 1024, 0x20);
    const { fetchImpl } = fakePeer([async () => signed(huge)]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
      pages: 0,
      error: "the page is larger than 1048576 bytes",
    });
  });

  it("refuses a page with more entries than asked for", async () => {
    const items = Array.from({ length: PULL_PAGE_LIMIT + 1 }, (_, i) =>
      entry(peerSituation(PEER, `many-${i}`), 10, i + 1),
    );
    const { fetchImpl } = fakePeer([
      async () => signed(json(pageOf(items, `10.${PULL_PAGE_LIMIT + 1}`))),
    ]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
      pages: 0,
      error: `the page holds more than ${PULL_PAGE_LIMIT} entries`,
    });
    expect(await landed()).toEqual([]);
  });

  it("refuses a page whose entries lie outside what was asked for", async () => {
    await sql`
      INSERT INTO conditions.federation_peer_cursor (peer_instance_id, cursor, updated_at)
      VALUES (${PEER}, '20.5', now())`;
    const replayed = pageOf([entry(peerSituation(PEER, "old"), 20, 5)], "20.6");
    const beyond = pageOf([entry(peerSituation(PEER, "beyond"), 21, 1)], "20.9");
    for (const page of [replayed, beyond]) {
      const { fetchImpl } = fakePeer([async () => signed(json(page))]);
      expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
        pages: 0,
        error: "the page's entries lie outside the cursor it was asked for",
      });
    }
    expect(await landed()).toEqual([]);
    expect(await cursor()).toBe("20.5");
  });

  it("stops at a page that says there is more without moving its cursor", async () => {
    const stuck = () =>
      signed(json(pageOf([], "0.0", { next: `https://${PEER}/peer/outbox?after=0.0` })));
    const { fetchImpl, asked } = fakePeer([stuck, stuck, stuck]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ pages: 1 });
    expect(asked).toHaveLength(1);
  });

  it("takes no more of a peer than its tier's rate admits a push", async () => {
    const items = [entry(peerSituation(PEER, "rated"), 10, 1)];
    const { fetchImpl } = fakePeer([async () => signed(json(pageOf(items, "10.1")))]);
    const rateLimiter = createInMemoryRateLimiter({
      policyForTier: () => ({ inboxPerMin: 0, backfillPerMin: 0 }),
      maxPageSize: 0,
    });
    expect(await pullPeer(sql, peer(), ctx(fetchImpl, { rateLimiter }))).toMatchObject({
      pages: 0,
      error: "the peer's pages exceed the rate its tier is admitted",
    });
    expect(await landed()).toEqual([]);
  });

  it("gives up on a page that does not arrive in time", async () => {
    const slow = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const started = Date.now();
    const result = await pullPeer(sql, peer(), ctx(slow, { pageTimeoutMs: 200 }));
    expect(result.error).toMatch(/could not be reached/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
