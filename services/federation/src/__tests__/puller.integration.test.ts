/**
 * The pull of a peer against a peer that misbehaves: every page must pass
 * what a pushed page passes (the peer's pin and signature, its block, the
 * admission of each record) and stay within what was asked for (entries,
 * bytes, time). The pull itself is bounded by a time slice, not by a rate.
 * The peer is a fake that serves pages signed with a key the peer record pins.
 */
import { runMigrations } from "@openconditions/core/server";
import {
  blockPeer,
  generateInstanceKey,
  InMemoryNonceStore,
  type InstanceKey,
  type PeerRecord,
  signMessage,
  storePeerVersions,
  unblockPeer,
} from "@openconditions/federation";
import { schemaVersions } from "@openconditions/model";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database/profile";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PULL_PAGE_LIMIT, type PullContext, pullPeer } from "../puller.js";
import { peerSituation, registry } from "./record-fixtures.js";

const PEER = "peer.example.org";
const LOCAL = "local.example.org";

const setupOrder = vi.hoisted(() => [] as string[]);
vi.mock("@openconditions/core/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@openconditions/core/server")>();
  return {
    ...original,
    runMigrations: async (...args: Parameters<typeof original.runMigrations>) => {
      setupOrder.push("migrate");
      return original.runMigrations(...args);
    },
  };
});
vi.mock("@openconditions/test-database/profile", async (importOriginal) => {
  const original = await importOriginal<typeof import("@openconditions/test-database/profile")>();
  return {
    ...original,
    assertPostgisProfile: async (...args: Parameters<typeof original.assertPostgisProfile>) => {
      setupOrder.push("verify");
      return original.assertPostgisProfile(...args);
    },
  };
});

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

/** The epoch of the peer's journal, and one it starts over with. */
const EPOCH = "6c1f0a52-3a8e-4e55-9a51-0d6f3c1b7e01";
const NEXT_EPOCH = "0b9d7e3c-5f21-4c7a-8e44-2a6b9f8d1c02";

const pageOf = (items: unknown[], highWaterMark: string, more: Rec = {}) => ({
  type: "OrderedCollectionPage",
  partOf: `https://${PEER}/peer/outbox`,
  highWaterMark,
  epoch: EPOCH,
  orderedItems: items,
  ...more,
});

/** A request as the fake peer receives it. */
interface Asked {
  url: string;
  headers: Record<string, string>;
}

type Answer = (asked: Asked) => Promise<Response>;

/**
 * An answer the peer signs with `key`, bound to the request it answers;
 * `boundTo` binds it to another request instead.
 */
function signed(
  body: Buffer,
  key = peerKey,
  status = 200,
  boundTo?: (asked: Asked) => Asked,
): Answer {
  return async (asked) => {
    const answered = boundTo === undefined ? asked : boundTo(asked);
    const request = { method: "GET", ...answered };
    const s = await signMessage({
      ...request,
      headers: { "content-type": "application/json" },
      body,
      keyId: key.keyId,
      privateKey: key.privateKey,
      isResponse: true,
      status,
      request,
    });
    return new Response(new Uint8Array(body), { status, headers: s.headers });
  };
}

/** A peer that answers each request with the next of `answers`, recording the URLs asked. */
function fakePeer(answers: Answer[]) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input));
    const next = answers.shift();
    if (next === undefined) throw new Error("no more answers");
    return next({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
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

const storedCursor = async () =>
  (
    await sql<{ cursor: string; journal_epoch: string | null; cursor_reset_at: Date | null }[]>`
      SELECT cursor, journal_epoch, cursor_reset_at
        FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${PEER}`
  )[0];

const availability = async () =>
  (
    await sql<{ availability_ok: number; availability_fail: number }[]>`
      SELECT availability_ok, availability_fail
        FROM conditions.federation_peer_health WHERE peer_id = ${PEER}`
  )[0] ?? { availability_ok: 0, availability_fail: 0 };

const schemaFailures = async () =>
  (
    await sql<{ schema_failures: number }[]>`
      SELECT schema_failures FROM conditions.federation_peer_health WHERE peer_id = ${PEER}`
  )[0]?.schema_failures ?? 0;

/** A cursor this instance holds of the peer's journal. */
async function holdCursor(at: string, epoch: string, resetAt: Date | null = null) {
  await sql`
    INSERT INTO conditions.federation_peer_cursor
      (peer_instance_id, cursor, updated_at, journal_epoch, cursor_reset_at)
    VALUES (${PEER}, ${at}, now(), ${epoch}, ${resetAt})`;
}

beforeAll(async () => {
  const profile = postgisProfile();
  const container = await new GenericContainer(POSTGIS_IMAGES[profile])
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
  sql = postgres(url, { max: 4, onnotice: () => {} });
  await assertPostgisProfile(sql, profile, {
    fixture: "puller.integration.test",
    containerId: container.getId(),
  });
  await runMigrations(url);
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
  it("checks the physical major before applying migrations", () => {
    expect(setupOrder).toEqual(["verify", "migrate"]);
  });

  it("lands a signed page through the inbox and advances its cursor", async () => {
    const { fetchImpl, asked } = fakePeer([
      signed(json(pageOf([entry(peerSituation(PEER, "ok-1"), 10, 1)], "10.1"))),
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
    const { fetchImpl } = fakePeer([signed(page, stranger)]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
      pages: 0,
      error: "the page does not carry the peer's signature",
    });
    expect(await landed()).toEqual([]);
  });

  it("refuses a genuine page signed as the answer to another request", async () => {
    const page = json(pageOf([entry(peerSituation(PEER, "elsewhere"), 10, 1)], "10.1"));
    const otherCursor = (asked: Asked) => ({
      ...asked,
      url: asked.url.replace("after=0.0", "after=5.0"),
    });
    const withoutSignature = (asked: Asked) => ({ ...asked, headers: {} });
    for (const boundTo of [otherCursor, withoutSignature]) {
      const { fetchImpl } = fakePeer([signed(page, peerKey, 200, boundTo)]);
      expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
        pages: 0,
        error: "the page does not carry the peer's signature",
      });
    }
    expect(await landed()).toEqual([]);
    expect(await cursor()).toBeUndefined();
  });

  it("admits each record as a pushed one: another instance's record is refused", async () => {
    const relayed = peerSituation("third.example.org", "relayed");
    const { fetchImpl } = fakePeer([signed(json(pageOf([entry(relayed, 10, 1)], "10.1")))]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ accepted: 0, skipped: 1 });
    expect(await landed()).toEqual([]);
  });

  it("asks again with a smaller limit for a page that is too large, and keeps it for the pull", async () => {
    const huge = signed(Buffer.alloc(2 * 1024 * 1024, 0x20));
    const { fetchImpl, asked } = fakePeer([
      huge,
      signed(
        json(
          pageOf([entry(peerSituation(PEER, "smaller-1"), 10, 1)], "10.1", {
            next: `https://${PEER}/peer/backfill?after=10.1`,
          }),
        ),
      ),
      signed(json(pageOf([entry(peerSituation(PEER, "smaller-2"), 10, 2)], "10.2"))),
    ]);
    const result = await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(result).toMatchObject({ pages: 2, accepted: 2, cursor: "10.2" });
    expect(result.error).toBeUndefined();
    expect(await landed()).toEqual(["smaller-1", "smaller-2"]);
    const limits = asked.map((url) => new URL(url).searchParams.get("limit"));
    const quarter = String(Math.floor(PULL_PAGE_LIMIT / 4));
    expect(limits).toEqual([String(PULL_PAGE_LIMIT), quarter, quarter]);
    expect(new URL(asked[1]!).searchParams.get("after")).toBe("0.0");
    expect(await schemaFailures()).toBe(0);

    const next = fakePeer([signed(json(pageOf([], "10.2")))]);
    await pullPeer(sql, peer(), ctx(next.fetchImpl));
    expect(new URL(next.asked[0]!).searchParams.get("limit")).toBe(String(PULL_PAGE_LIMIT));
  });

  it("refuses a page still too large at a limit of 1, unread past the cap", async () => {
    const limits = [PULL_PAGE_LIMIT];
    while (limits.at(-1)! > 1) limits.push(Math.max(1, Math.floor(limits.at(-1)! / 4)));
    const huge = signed(Buffer.alloc(2 * 1024 * 1024, 0x20));
    const { fetchImpl, asked } = fakePeer(limits.map(() => huge));
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
      pages: 0,
      error: "a single entry is larger than 1048576 bytes",
    });
    expect(asked.map((url) => new URL(url).searchParams.get("limit"))).toEqual(limits.map(String));
    expect(await schemaFailures()).toBe(1);
  });

  it("refuses a page with more entries than asked for", async () => {
    const items = Array.from({ length: PULL_PAGE_LIMIT + 1 }, (_, i) =>
      entry(peerSituation(PEER, `many-${i}`), 10, i + 1),
    );
    const { fetchImpl } = fakePeer([signed(json(pageOf(items, `10.${PULL_PAGE_LIMIT + 1}`)))]);
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
      const { fetchImpl } = fakePeer([signed(json(page))]);
      expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
        pages: 0,
        error: "the page's entries lie outside the cursor it was asked for",
      });
    }
    expect(await landed()).toEqual([]);
    expect(await cursor()).toBe("20.5");
  });

  it("stops at a page that says there is more without moving its cursor", async () => {
    const stuck = signed(
      json(pageOf([], "0.0", { next: `https://${PEER}/peer/outbox?after=0.0` })),
    );
    const { fetchImpl, asked } = fakePeer([stuck, stuck, stuck]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ pages: 1 });
    expect(asked).toHaveLength(1);
  });

  it("lands several thousand entries in one pull, metering none of them", async () => {
    const total = 2_000;
    const pages = total / PULL_PAGE_LIMIT;
    const answers = Array.from({ length: pages }, (_, p) => {
      const items = Array.from({ length: PULL_PAGE_LIMIT }, (_, i) => {
        const seq = p * PULL_PAGE_LIMIT + i + 1;
        return entry(peerSituation(PEER, `bulk-${seq}`), 10, seq);
      });
      const last = `10.${(p + 1) * PULL_PAGE_LIMIT}`;
      const more = p < pages - 1 ? { next: `https://${PEER}/peer/backfill?after=${last}` } : {};
      return signed(json(pageOf(items, last, more)));
    });
    const { fetchImpl, asked } = fakePeer(answers);
    const fixed = new Date().toISOString();
    const result = await pullPeer(sql, peer(), ctx(fetchImpl, { now: () => fixed }));
    expect(result).toMatchObject({ pages, accepted: total, more: false, cursor: `10.${total}` });
    expect(result.error).toBeUndefined();
    expect(asked).toHaveLength(pages);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM conditions.situation`;
    expect(n).toBe(total);
  }, 120_000);

  it("yields at its time slice with more to read, and the next pull goes on from its cursor", async () => {
    let clock = Date.now();
    const page = (seq: number) =>
      pageOf([entry(peerSituation(PEER, `slice-${seq}`), 10, seq)], `10.${seq}`, {
        next: `https://${PEER}/peer/backfill?after=10.${seq}`,
      });
    const ticking =
      (answer: Answer): Answer =>
      async (asked) => {
        clock += 10_000;
        return answer(asked);
      };
    const first = fakePeer([ticking(signed(json(page(1)))), ticking(signed(json(page(2))))]);
    const now = () => new Date(clock).toISOString();
    const result = await pullPeer(sql, peer(), ctx(first.fetchImpl, { now, sliceMs: 15_000 }));
    expect(result).toMatchObject({ pages: 2, accepted: 2, more: true, cursor: "10.2" });
    expect(result.error).toBeUndefined();
    expect(await cursor()).toBe("10.2");

    const second = fakePeer([
      signed(json(pageOf([entry(peerSituation(PEER, "slice-3"), 10, 3)], "10.3"))),
    ]);
    const rest = await pullPeer(sql, peer(), ctx(second.fetchImpl, { now, sliceMs: 15_000 }));
    expect(rest).toMatchObject({ pages: 1, accepted: 1, more: false, cursor: "10.3" });
    expect(new URL(second.asked[0]!).searchParams.get("after")).toBe("10.2");
    expect(await landed()).toEqual(["slice-1", "slice-2", "slice-3"]);
  });

  it("passes on how long a peer asked to be left alone, counting no failure", async () => {
    const wait =
      (status: number, retryAfter?: string): Answer =>
      async () =>
        new Response(JSON.stringify({ error: "later" }), {
          status,
          headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
        });
    for (const [answer, expected] of [
      [wait(429, "7"), 7],
      [wait(503, "12"), 12],
      [wait(429), 60],
      [wait(429, "soon"), 60],
    ] as const) {
      const { fetchImpl } = fakePeer([answer]);
      const result = await pullPeer(sql, peer(), ctx(fetchImpl));
      expect(result).toMatchObject({ pages: 0, more: true, retryAfterSec: expected });
      expect(result.error).toMatch(/asked to retry later/);
    }
    const unsure = fakePeer([wait(503)]);
    expect((await pullPeer(sql, peer(), ctx(unsure.fetchImpl))).retryAfterSec).toBeUndefined();
    expect(await availability()).toMatchObject({ availability_fail: 0 });
    expect(await schemaFailures()).toBe(0);
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

describe("following the epoch of the peer's journal", () => {
  it("keeps the epoch with the cursor from the first page on", async () => {
    const { fetchImpl } = fakePeer([
      signed(json(pageOf([entry(peerSituation(PEER, "first"), 10, 1)], "10.1"))),
    ]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ pages: 1, accepted: 1 });
    expect(await storedCursor()).toMatchObject({ cursor: "10.1", journal_epoch: EPOCH });
  });

  it("notes the epoch even when the page moves the cursor nowhere", async () => {
    const { fetchImpl } = fakePeer([signed(json(pageOf([], "0.0")))]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ pages: 1 });
    expect(await storedCursor()).toMatchObject({ cursor: "0.0", journal_epoch: EPOCH });
  });

  it("reads the journal again from the start when the peer's epoch changed", async () => {
    await holdCursor("20.5", EPOCH);
    const { fetchImpl, asked } = fakePeer([
      signed(
        json(pageOf([entry(peerSituation(PEER, "voided"), 30, 1)], "30.1", { epoch: NEXT_EPOCH })),
      ),
      signed(
        json(pageOf([entry(peerSituation(PEER, "again"), 5, 1)], "5.1", { epoch: NEXT_EPOCH })),
      ),
    ]);
    const result = await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(result).toMatchObject({ reset: "epoch", pages: 1, accepted: 1, cursor: "5.1" });
    expect(result.error).toBeUndefined();
    expect(await landed()).toEqual(["again"]);
    expect(asked[0]).toContain("/peer/outbox?");
    expect(asked[0]).toContain("after=20.5");
    expect(asked[1]).toContain("/peer/backfill?");
    expect(asked[1]).toContain("after=0.0");
    const held = await storedCursor();
    expect(held).toMatchObject({ cursor: "5.1", journal_epoch: NEXT_EPOCH });
    expect(held?.cursor_reset_at).not.toBeNull();
  });

  it("reads the journal again from the start when the peer says the cursor is ahead of it", async () => {
    await holdCursor("20.5", EPOCH);
    const { fetchImpl, asked } = fakePeer([
      signed(json(pageOf([], "20.5", { cursorAhead: true }))),
      signed(json(pageOf([entry(peerSituation(PEER, "behind"), 7, 2)], "7.2"))),
    ]);
    const result = await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(result).toMatchObject({ reset: "ahead", pages: 1, accepted: 1, cursor: "7.2" });
    expect(asked[1]).toContain("after=0.0");
    expect(await storedCursor()).toMatchObject({ cursor: "7.2", journal_epoch: EPOCH });
  });

  it("refuses a second restart within the hour as the peer's fault, leaving the cursor", async () => {
    await holdCursor("20.5", EPOCH, new Date(Date.now() - 10 * 60_000));
    const { fetchImpl } = fakePeer([signed(json(pageOf([], "20.5", { epoch: NEXT_EPOCH })))]);
    const result = await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(result).toMatchObject({
      pages: 0,
      error: "the peer's journal restarted again within the hour",
    });
    expect(result.reset).toBeUndefined();
    expect(await schemaFailures()).toBe(1);
    expect(await storedCursor()).toMatchObject({ cursor: "20.5", journal_epoch: EPOCH });
  });

  it("follows a restart again once the hour has passed", async () => {
    await holdCursor("20.5", EPOCH, new Date(Date.now() - 61 * 60_000));
    const { fetchImpl } = fakePeer([
      signed(json(pageOf([], "20.5", { epoch: NEXT_EPOCH }))),
      signed(json(pageOf([], "0.0", { epoch: NEXT_EPOCH }))),
    ]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ reset: "epoch" });
  });

  it("refuses a second restart within one pull", async () => {
    await holdCursor("20.5", EPOCH);
    const { fetchImpl } = fakePeer([
      signed(json(pageOf([], "20.5", { cursorAhead: true }))),
      signed(
        json(
          pageOf([entry(peerSituation(PEER, "landed-once"), 3, 1)], "3.1", {
            next: `https://${PEER}/peer/backfill?after=3.1`,
          }),
        ),
      ),
      signed(json(pageOf([], "3.1", { cursorAhead: true }))),
    ]);
    const result = await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(result).toMatchObject({
      reset: "ahead",
      pages: 1,
      cursor: "3.1",
      error: "the peer's journal restarted again within this pull",
    });
    expect(await schemaFailures()).toBe(1);
    expect(await cursor()).toBe("3.1");
  });

  it("refuses a page that says the start of the journal is ahead of it", async () => {
    const { fetchImpl } = fakePeer([signed(json(pageOf([], "0.0", { cursorAhead: true })))]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
      pages: 0,
      error: "the page says the start of the journal is ahead of it",
    });
    expect(await schemaFailures()).toBe(1);
  });

  it("adopts another epoch at the start cursor without a reset", async () => {
    await holdCursor("0.0", EPOCH);
    const { fetchImpl } = fakePeer([
      signed(
        json(pageOf([entry(peerSituation(PEER, "adopted"), 4, 1)], "4.1", { epoch: NEXT_EPOCH })),
      ),
    ]);
    const result = await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(result).toMatchObject({ pages: 1, accepted: 1, cursor: "4.1" });
    expect(result.reset).toBeUndefined();
    expect(await storedCursor()).toMatchObject({
      cursor: "4.1",
      journal_epoch: NEXT_EPOCH,
      cursor_reset_at: null,
    });
  });

  it("refuses a page that names no epoch", async () => {
    for (const epoch of [undefined, "", "x".repeat(65), 42]) {
      const { fetchImpl } = fakePeer([
        signed(json(pageOf([entry(peerSituation(PEER, "no-epoch"), 10, 1)], "10.1", { epoch }))),
      ]);
      expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({
        pages: 0,
        error: "the page names no journal epoch",
      });
    }
    expect(await landed()).toEqual([]);
  });
});

describe("a page that says the cursor is beyond the window", () => {
  const reconcileState = async () =>
    (
      await sql<
        {
          reconcile_due_since: Date | null;
          reconcile_class: string | null;
          reconciled_at: Date | null;
        }[]
      >`
        SELECT reconcile_due_since, reconcile_class, reconciled_at
          FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${PEER}`
    )[0];
  const beyond = () => signed(json(pageOf([], "20.5", { beyondWindow: true })));

  it("makes a comparison due when none is due and none finished within a day", async () => {
    await holdCursor("20.5", EPOCH);
    await sql`
      UPDATE conditions.federation_peer_cursor SET reconciled_at = now() - interval '2 days'
       WHERE peer_instance_id = ${PEER}`;
    const { fetchImpl } = fakePeer([beyond()]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ beyondWindow: true });
    expect((await reconcileState())?.reconcile_due_since).not.toBeNull();
  });

  it("does not make one due again within a day of the last one finishing", async () => {
    await holdCursor("20.5", EPOCH);
    await sql`
      UPDATE conditions.federation_peer_cursor SET reconciled_at = now() - interval '1 hour'
       WHERE peer_instance_id = ${PEER}`;
    const { fetchImpl } = fakePeer([beyond()]);
    expect(await pullPeer(sql, peer(), ctx(fetchImpl))).toMatchObject({ beyondWindow: true });
    expect((await reconcileState())?.reconcile_due_since).toBeNull();
  });

  it("makes one due when the peer had not answered a pull for 30 days, whatever the page says", async () => {
    await holdCursor("20.5", EPOCH);
    await sql`
      UPDATE conditions.federation_peer_cursor SET updated_at = now() - interval '31 days'
       WHERE peer_instance_id = ${PEER}`;
    // The peer pruned every entry since: its page is empty and names no window.
    const { fetchImpl } = fakePeer([signed(json(pageOf([], "20.5")))]);
    const result = await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(result).toMatchObject({ longAbsence: true });
    expect(result.beyondWindow).toBeUndefined();
    expect((await reconcileState())?.reconcile_due_since).not.toBeNull();
    // The answer is noted, so the next pull finds no absence.
    await sql`
      UPDATE conditions.federation_peer_cursor
         SET reconcile_due_since = NULL, reconciled_at = now() - interval '2 days'
       WHERE peer_instance_id = ${PEER}`;
    const again = fakePeer([signed(json(pageOf([], "20.5")))]);
    expect((await pullPeer(sql, peer(), ctx(again.fetchImpl))).longAbsence).toBeUndefined();
    expect((await reconcileState())?.reconcile_due_since).toBeNull();
  });

  it("makes none due for a peer that answered within 30 days, or one that does not answer", async () => {
    await holdCursor("20.5", EPOCH);
    await sql`
      UPDATE conditions.federation_peer_cursor SET updated_at = now() - interval '29 days'
       WHERE peer_instance_id = ${PEER}`;
    const { fetchImpl } = fakePeer([signed(json(pageOf([], "20.5")))]);
    expect((await pullPeer(sql, peer(), ctx(fetchImpl))).longAbsence).toBeUndefined();
    expect((await reconcileState())?.reconcile_due_since).toBeNull();
    await sql`
      UPDATE conditions.federation_peer_cursor SET updated_at = now() - interval '31 days'
       WHERE peer_instance_id = ${PEER}`;
    const down = fakePeer([async () => new Response("no", { status: 502 })]);
    expect((await pullPeer(sql, peer(), ctx(down.fetchImpl))).error).toBeDefined();
    expect((await reconcileState())?.reconcile_due_since).toBeNull();
  });

  it("never restarts a comparison already running", async () => {
    await holdCursor("20.5", EPOCH);
    await sql`
      UPDATE conditions.federation_peer_cursor
         SET reconcile_due_since = '2026-01-01T00:00:00Z', reconcile_class = 'situation'
       WHERE peer_instance_id = ${PEER}`;
    const { fetchImpl } = fakePeer([beyond()]);
    await pullPeer(sql, peer(), ctx(fetchImpl));
    expect(await reconcileState()).toMatchObject({
      reconcile_due_since: new Date("2026-01-01T00:00:00Z"),
      reconcile_class: "situation",
    });
  });

  it("says whether the pull moved the cursor", async () => {
    await holdCursor("20.5", EPOCH);
    const still = fakePeer([signed(json(pageOf([], "20.5")))]);
    expect(await pullPeer(sql, peer(), ctx(still.fetchImpl))).toMatchObject({ advanced: false });
    const moved = fakePeer([
      signed(json(pageOf([entry(peerSituation(PEER, "moved"), 21, 1)], "21.1"))),
    ]);
    expect(await pullPeer(sql, peer(), ctx(moved.fetchImpl))).toMatchObject({ advanced: true });
  });
});
