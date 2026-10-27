/**
 * Two instances peering end to end, each with its own database on one
 * server: B keeps a subscription at A from its peers config, A pushes its
 * outbox to B's inbox, and B lands what A publishes, the liveness of A's
 * sources included. Requests travel between the two apps in process.
 */
import { runMigrations } from "@openconditions/core/server";
import {
  createInMemoryRateLimiter,
  InMemoryNonceStore,
  type InstanceKey,
  loadActiveKeys,
  maintainInstanceKey,
  type RecordFilter,
  rotateInstanceKey,
  runWebhookDeliveryCycle,
} from "@openconditions/federation";
import {
  journalSourceLiveness,
  seedFederation,
  syncSources,
  tombstoneRecords,
  writeSnapshot,
} from "@openconditions/storage";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database/profile";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FederationSettings, resolveFederationSettings } from "../config.js";
import { PeerBook } from "../peer-book.js";
import { refreshPeers } from "../peering.js";
import { pullPeer } from "../puller.js";
import { build } from "../server.js";
import { registry } from "./record-fixtures.js";

const A = "a.example.org";
const B = "b.example.org";
/** Pushed only A's priority entries, and pulling A for the rest. */
const C = "c.example.org";
const SOURCE = "nl-ndw-events";

let containerStop: () => Promise<unknown>;
let sqlA: postgres.Sql;
let sqlB: postgres.Sql;
let sqlC: postgres.Sql;
let keyA: InstanceKey;
let keyC: InstanceKey;
let appA: FastifyInstance;
let appB: FastifyInstance;
let appC: FastifyInstance;
let settingsA: FederationSettings;
let settingsB: FederationSettings;
let settingsC: FederationSettings;
let peersA: PeerBook;
let peersB: PeerBook;
let peersC: PeerBook;

const actor = (instanceId: string) => ({
  instanceId,
  baseUrl: `https://${instanceId}`,
  operator: `Operator of ${instanceId}`,
  jurisdiction: "NL",
  coverage: { iso3166: ["NL"] },
  license: "ODbL-1.0",
  trustTier: 1,
  capabilities: {
    protocolVersion: "0.1",
    wireFormats: ["application/activity+json"],
    deliveryModes: ["pull", "webhook", "sse"],
    subscriptionFilters: ["bbox", "classes", "domains"],
    maxEventRate: 10,
    convergenceBound: 300,
  },
});

const peer = (instanceId: string, key: InstanceKey, over: Record<string, unknown> = {}) => ({
  instanceId,
  actorUrl: `https://${instanceId}/.well-known/openconditions/actor.json`,
  trustTier: 1,
  pinnedKeys: [key.keyId],
  ...over,
});

const SUBSCRIBE = {
  filter: {
    classes: ["situation", "observation"],
    domains: ["roads"],
    kinds: ["incident"],
    properties: ["traffic.los"],
    sourceLiveness: true,
  },
  priorityOnly: false,
};

const PULL_FILTER: RecordFilter = {
  classes: ["situation", "observation"],
  domains: ["roads"],
  kinds: ["incident", "roadworks"],
  properties: ["traffic.los"],
  sourceLiveness: true,
};

/** Carries a request to the app serving its host, as the network would. */
function network(apps: Record<string, () => FastifyInstance>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const app = apps[url.host];
    if (app === undefined) throw new TypeError(`fetch failed: no route to ${url.host}`);
    const res = await app().inject({
      method: (init?.method ?? "GET") as "GET",
      url: url.pathname + url.search,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body !== undefined && init.body !== null ? { payload: init.body as Buffer } : {}),
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
    const empty = res.statusCode === 204 || res.statusCode === 304;
    return new Response(empty ? null : new Uint8Array(res.rawPayload), {
      status: res.statusCode,
      headers,
    });
  }) as typeof fetch;
}

const fetchImpl = network({ [A]: () => appA, [B]: () => appB, [C]: () => appC });

/** One of A's own feed situations, as its poll drafts it: an incident is a priority entry. */
function situationDraft(local: string, kind: "incident" | "roadworks" = "incident") {
  return {
    id: `oc:situation:${SOURCE}:${local}`,
    class: "situation",
    kind,
    type: kind === "incident" ? "obstruction" : "works",
    temporality: "live",
    planned: kind === "roadworks",
    certainty: "observed",
    severity: { label: "moderate", source: "derived" },
    headline: [{ lang: "en", text: local }],
    validity: { status: "active", start: "2026-07-13T09:00:00Z" },
    effects: [],
    details: { kind, v: 1 },
    location: {
      geometry: { type: "Point", coordinates: [5.1, 52.1] },
      extent: "point",
      geometryOrigin: "source",
      fuzziness: "exact",
    },
    provenance: {
      origin: "feed",
      sourceId: SOURCE,
      sourceFormat: "datex2",
      accessMode: "bulk",
      recordId: local,
      attribution: { provider: "NDW", license: "CC0-1.0" },
      privacy: { class: "authoritative" },
    },
    freshness: { fetchedAt: new Date().toISOString() },
  };
}

beforeAll(async () => {
  // A server of its own: the outbox fence reads the server-wide xmin horizon.
  const profile = postgisProfile();
  const container = await new GenericContainer(POSTGIS_IMAGES[profile])
    .withEnvironment({ POSTGRES_DB: "a", POSTGRES_USER: "oc", POSTGRES_PASSWORD: "oc" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const server = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}`;
  const admin = postgres(`${server}/a`, { max: 1 });
  try {
    await assertPostgisProfile(admin, profile, {
      fixture: "peering.integration.test.ts",
      containerId: container.getId(),
    });
    await admin.unsafe("CREATE DATABASE b");
    await admin.unsafe("CREATE DATABASE c");
  } finally {
    await admin.end();
  }
  await runMigrations(`${server}/a`);
  await runMigrations(`${server}/b`);
  await runMigrations(`${server}/c`);
  sqlA = postgres(`${server}/a`, { max: 4, onnotice: () => {} });
  sqlB = postgres(`${server}/b`, { max: 4, onnotice: () => {} });
  sqlC = postgres(`${server}/c`, { max: 4, onnotice: () => {} });

  const now = new Date().toISOString();
  await maintainInstanceKey(sqlA, now, A);
  await maintainInstanceKey(sqlB, now, B);
  await maintainInstanceKey(sqlC, now, C);
  [keyA] = (await loadActiveKeys(sqlA, now)) as [InstanceKey];
  const [keyB] = (await loadActiveKeys(sqlB, now)) as [InstanceKey];
  [keyC] = (await loadActiveKeys(sqlC, now)) as [InstanceKey];

  const envA = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: A,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(actor(A)),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([peer(B, keyB), peer(C, keyC)]),
  };
  const envC = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: C,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(actor(C)),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([
      peer(A, keyA, {
        subscribe: { filter: PULL_FILTER, priorityOnly: true },
        pull: { filter: PULL_FILTER },
      }),
    ]),
  };
  settingsC = resolveFederationSettings(envC);
  peersC = await PeerBook.load(sqlC, settingsC.peers);
  appC = await build({ sql: sqlC, env: envC, logger: false, peers: peersC });
  const envB = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: B,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(actor(B)),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([peer(A, keyA, { subscribe: SUBSCRIBE })]),
  };
  settingsA = resolveFederationSettings(envA);
  settingsB = resolveFederationSettings(envB);
  peersA = await PeerBook.load(sqlA, settingsA.peers);
  peersB = await PeerBook.load(sqlB, settingsB.peers);
  appA = await build({ sql: sqlA, env: envA, logger: false, peers: peersA });
  appB = await build({ sql: sqlB, env: envB, logger: false, peers: peersB });

  await syncSources(sqlA, [
    {
      id: SOURCE,
      domain: "roads",
      format: "datex2",
      product: "events",
      tier: "authoritative",
      country: "NL",
      operator: "NDW",
      license: "CC0-1.0",
      attribution: "NDW",
      restricted: false,
      cadenceSec: 60,
      freshnessWindowSec: 600,
    },
  ]);
  // Stored while nobody subscribed: nothing of it is journalled.
  await writeSnapshot(
    sqlA,
    SOURCE,
    { situations: [situationDraft("before-1")] },
    { registry, instanceId: A, now, complete: true },
  );
}, 180_000);

afterAll(async () => {
  await appA?.close();
  await appB?.close();
  await appC?.close();
  await sqlA?.end();
  await sqlB?.end();
  await sqlC?.end();
  await containerStop?.();
}, 30_000);

const subscriptionsAtA = () =>
  sqlA<{ peer_id: string; inbox_url: string; status: string; priority_only: boolean }[]>`
    SELECT peer_id, inbox_url, status, priority_only FROM conditions.federation_subscription`;

describe("two peered instances", () => {
  it("subscribes B at A from B's peers config, once", async () => {
    const [upkeep] = await refreshPeers(sqlB, settingsB, peersB, {
      fetchImpl,
      now: new Date().toISOString(),
    });
    expect(upkeep).toMatchObject({
      peer: A,
      capabilities: { ok: true },
      subscription: { ok: true, status: "created" },
    });
    expect(await subscriptionsAtA()).toEqual([
      {
        peer_id: B,
        inbox_url: `https://${B}/peer/inbox`,
        status: "active",
        priority_only: false,
      },
    ]);
    const [again] = await refreshPeers(sqlB, settingsB, peersB, {
      fetchImpl,
      now: new Date().toISOString(),
    });
    expect(again!.subscription).toMatchObject({ ok: true, status: "unchanged" });
    // A subscribes to nobody.
    const [fromA] = await refreshPeers(sqlA, settingsA, peersA, {
      fetchImpl,
      now: new Date().toISOString(),
    });
    expect(fromA).toEqual({ peer: B, capabilities: expect.objectContaining({ ok: true }) });
  }, 60_000);

  it("lands at B what A held before, what A publishes, and A's liveness of the source", async () => {
    // What A's service does once a peer subscribed.
    expect(await seedFederation(sqlA)).toEqual({ journalled: 1, busy: [] });
    const now = new Date().toISOString();
    await writeSnapshot(
      sqlA,
      SOURCE,
      { situations: [situationDraft("before-1"), situationDraft("e2e-1")] },
      { registry, instanceId: A, now, complete: true },
    );
    await sqlA.begin((tx) => journalSourceLiveness(tx, SOURCE));

    const pushed = await runWebhookDeliveryCycle(sqlA, {
      signingKey: keyA,
      fetchImpl,
      partOf: `https://${A}/peer/outbox`,
    });
    expect(pushed).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });

    const landed = await sqlB<{ id: string; instance_id: string; revision: number }[]>`
      SELECT id, instance_id, revision FROM conditions.situation ORDER BY id`;
    expect(landed).toEqual(
      ["before-1", "e2e-1"].map((local) => ({
        id: `oc:situation:${SOURCE}:${local}`,
        instance_id: A,
        revision: 1,
      })),
    );
    const receipts = await sqlB<{ peer_instance_id: string; source_id: string }[]>`
      SELECT peer_instance_id, source_id FROM conditions.federation_source_receipt`;
    expect(receipts).toEqual([{ peer_instance_id: A, source_id: SOURCE }]);

    // Nothing new: the next cycle pushes nothing.
    expect(
      await runWebhookDeliveryCycle(sqlA, {
        signingKey: keyA,
        fetchImpl,
        partOf: `https://${A}/peer/outbox`,
      }),
    ).toMatchObject({ attempted: 1, delivered: 0 });
  }, 60_000);

  it("resumes a push A disabled at B's next upkeep", async () => {
    await sqlA`UPDATE conditions.federation_subscription SET status = 'push_disabled'`;
    const [upkeep] = await refreshPeers(sqlB, settingsB, peersB, {
      fetchImpl,
      now: new Date().toISOString(),
    });
    expect(upkeep!.subscription).toMatchObject({ ok: true, status: "updated" });
    expect((await subscriptionsAtA()).map((s) => s.status)).toEqual(["active"]);
  }, 60_000);

  it("does not serve what B subscribes to in its public peers document", async () => {
    const res = await appB.inject({ method: "GET", url: "/.well-known/openconditions/peers.json" });
    expect(res.json().peers[0]).not.toHaveProperty("subscribe");
  });
});

describe("a peer that pulls", () => {
  const pullCtx = () => ({
    registry,
    localInstanceId: C,
    signingKey: keyC,
    fetchImpl,
    nonceStore: new InMemoryNonceStore(),
    rateLimiter: createInMemoryRateLimiter(),
    now: () => new Date().toISOString(),
  });
  const pullA = () =>
    pullPeer(sqlC, { ...settingsC.peers[0]!, pull: { filter: PULL_FILTER } }, pullCtx());
  const situationsAtC = async () =>
    (
      await sqlC<{ id: string }[]>`
        SELECT id FROM conditions.situation WHERE tombstoned_at IS NULL ORDER BY id`
    ).map((r) => r.id.slice(r.id.lastIndexOf(":") + 1));

  it("keeps a priority push and a pull subscription at A from its config", async () => {
    const [upkeep] = await refreshPeers(sqlC, settingsC, peersC, {
      fetchImpl,
      now: new Date().toISOString(),
    });
    expect(upkeep).toMatchObject({
      subscription: { ok: true, status: "created" },
      pullSubscription: { ok: true, status: "created" },
    });
    expect(
      await sqlA`SELECT delivery_mode, priority_only FROM conditions.federation_subscription
                  WHERE peer_id = ${C} ORDER BY delivery_mode`,
    ).toEqual([
      { delivery_mode: "pull", priority_only: false },
      { delivery_mode: "webhook", priority_only: true },
    ]);
  }, 60_000);

  it("gets by pull what the priority push leaves out, landing what both carry once", async () => {
    await writeSnapshot(
      sqlA,
      SOURCE,
      {
        situations: [
          situationDraft("before-1"),
          situationDraft("e2e-1"),
          situationDraft("pull-incident"),
          situationDraft("pull-works", "roadworks"),
        ],
      },
      { registry, instanceId: A, now: new Date().toISOString(), complete: true },
    );
    await sqlA`
      UPDATE conditions.federation_outbox SET created_at = now() - interval '11 minutes'
       WHERE operation = 'liveness'`;
    await sqlA.begin((tx) => journalSourceLiveness(tx, SOURCE));
    await runWebhookDeliveryCycle(sqlA, {
      signingKey: keyA,
      fetchImpl,
      partOf: `https://${A}/peer/outbox`,
    });
    // The push carried the incidents, not the roadworks.
    expect(await situationsAtC()).toEqual(["before-1", "e2e-1", "pull-incident"]);

    const pulled = await pullA();
    // From the start of A's journal: both of A's liveness entries.
    expect(pulled).toMatchObject({ skipped: 0, liveness: 2 });
    expect(pulled.error).toBeUndefined();
    expect(pulled.accepted).toBe(1);
    expect(pulled.stale).toBeGreaterThanOrEqual(3);
    expect(await situationsAtC()).toEqual(["before-1", "e2e-1", "pull-incident", "pull-works"]);
    const [stored] = await sqlC<{ cursor: string }[]>`
      SELECT cursor FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${A}`;
    expect(stored!.cursor).toBe(pulled.cursor);
    const [{ n }] = await sqlC`
      SELECT count(*)::int AS n FROM conditions.federation_source_receipt
       WHERE peer_instance_id = ${A} AND source_id = ${SOURCE}`;
    expect(n).toBe(1);

    // Nothing new: the next pull reads from its cursor and lands nothing.
    const again = await pullA();
    expect(again).toMatchObject({ pages: 1, accepted: 0, stale: 0, cursor: pulled.cursor });
  }, 60_000);

  it("refuses a page the peer did not sign", async () => {
    const unsigned = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetchImpl(input, init);
      const headers = new Headers(res.headers);
      headers.delete("signature");
      return new Response(await res.arrayBuffer(), { status: res.status, headers });
    }) as typeof fetch;
    const result = await pullPeer(
      sqlC,
      { ...settingsC.peers[0]!, pull: { filter: PULL_FILTER } },
      { ...pullCtx(), fetchImpl: unsigned },
    );
    expect(result).toMatchObject({
      pages: 0,
      error: "the page does not carry the peer's signature",
    });
  }, 60_000);

  it("never moves its cursor back behind one stored meanwhile", async () => {
    await writeSnapshot(
      sqlA,
      SOURCE,
      { situations: [situationDraft("race-1", "roadworks")] },
      { registry, instanceId: A, now: new Date().toISOString(), complete: false },
    );
    const ahead = "999999999999.1";
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      await sqlC`
        UPDATE conditions.federation_peer_cursor SET cursor = ${ahead}
         WHERE peer_instance_id = ${A}`;
      return fetchImpl(input, init);
    }) as typeof fetch;
    const result = await pullPeer(
      sqlC,
      { ...settingsC.peers[0]!, pull: { filter: PULL_FILTER } },
      { ...pullCtx(), fetchImpl: racing },
    );
    expect(result).toMatchObject({ pages: 1, accepted: 1 });
    const [stored] = await sqlC<{ cursor: string }[]>`
      SELECT cursor FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${A}`;
    expect(stored!.cursor).toBe(ahead);
    await sqlC`
      UPDATE conditions.federation_peer_cursor SET cursor = ${result.cursor}
       WHERE peer_instance_id = ${A}`;
  }, 60_000);

  it("keeps the newer copy a push brought when its pull replays an older retraction", async () => {
    const id = `oc:situation:${SOURCE}:flip`;
    const write = (n: number) =>
      writeSnapshot(
        sqlA,
        SOURCE,
        {
          situations: [
            { ...situationDraft("flip"), headline: [{ lang: "en", text: `flip ${n}` }] },
          ],
        },
        { registry, instanceId: A, now: new Date().toISOString(), complete: false },
      );
    await write(1);
    await pullA();
    // A's feed drops the incident, then lists it again: revisions 2 and 3.
    await sqlA.begin((tx) =>
      tombstoneRecords(tx, "situation", [id], "withdrawn", {
        registry,
        now: new Date().toISOString(),
      }),
    );
    await write(2);
    // The priority push carries both to C ahead of its pull.
    await runWebhookDeliveryCycle(sqlA, {
      signingKey: keyA,
      fetchImpl,
      partOf: `https://${A}/peer/outbox`,
    });
    const atC = async () =>
      (
        await sqlC<{ revision: number; tombstone_reason: string | null }[]>`
          SELECT revision, tombstone_reason FROM conditions.situation WHERE id = ${id}`
      )[0];
    expect(await atC()).toEqual({ revision: 3, tombstone_reason: null });

    const replayed = await pullA();
    expect(replayed).toMatchObject({ tombstoned: 0, skipped: 0 });
    expect(replayed.stale).toBeGreaterThanOrEqual(2);
    expect(await atC()).toEqual({ revision: 3, tombstone_reason: null });
  }, 60_000);
});

describe("a peer that rotates its key", () => {
  it("is followed by its pins: the key it rotated to verifies once its peers read it", async () => {
    const now = new Date().toISOString();
    const rotated = await rotateInstanceKey(sqlA, now, A);
    expect(rotated.endorsement?.by).toBe(keyA.keyId);
    // Push a new entry under the new key before B has read A's actor document.
    await writeSnapshot(
      sqlA,
      SOURCE,
      { situations: [situationDraft("before-1"), situationDraft("rotated-1")] },
      { registry, instanceId: A, now, complete: false },
    );
    const push = () =>
      runWebhookDeliveryCycle(sqlA, {
        signingKey: rotated,
        fetchImpl,
        partOf: `https://${A}/peer/outbox`,
      });
    // B and C both refuse it.
    expect(await push()).toMatchObject({ delivered: 0, failed: 2 });

    const [upkeep] = await refreshPeers(sqlB, settingsB, peersB, { fetchImpl, now });
    expect(upkeep!.capabilities).toMatchObject({
      ok: true,
      keys: new Map([
        [rotated.keyId, keyA.keyId],
        [keyA.keyId, keyA.keyId],
      ]),
    });
    expect(peersB.find(A)?.pinnedKeys).toContain(rotated.keyId);
    await sqlA`UPDATE conditions.federation_subscription SET push_failures = 0`;
    // B read A's document; C has not yet.
    expect(await push()).toMatchObject({ delivered: 1, failed: 1 });
    const [landed] = await sqlB<{ n: number }[]>`
      SELECT count(*)::int AS n FROM conditions.situation
       WHERE id = ${`oc:situation:${SOURCE}:rotated-1`}`;
    expect(landed!.n).toBe(1);
  }, 60_000);
});
