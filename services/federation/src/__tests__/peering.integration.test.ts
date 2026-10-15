/**
 * Two instances peering end to end, each with its own database on one
 * server: B keeps a subscription at A from its peers config, A pushes its
 * outbox to B's inbox, and B lands what A publishes, the liveness of A's
 * sources included. Requests travel between the two apps in process.
 */
import { runMigrations } from "@openconditions/core/server";
import {
  ensureInstanceKey,
  type InstanceKey,
  loadActiveKeys,
  runWebhookDeliveryCycle,
} from "@openconditions/federation";
import { journalSourceLiveness, syncSources, writeSnapshot } from "@openconditions/storage";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FederationSettings, resolveFederationSettings } from "../config.js";
import { refreshPeers } from "../peering.js";
import { build } from "../server.js";
import { registry } from "./record-fixtures.js";

const A = "a.example.org";
const B = "b.example.org";
const SOURCE = "nl-ndw-events";

let containerStop: () => Promise<unknown>;
let sqlA: postgres.Sql;
let sqlB: postgres.Sql;
let keyA: InstanceKey;
let appA: FastifyInstance;
let appB: FastifyInstance;
let settingsA: FederationSettings;
let settingsB: FederationSettings;

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

const fetchImpl = network({ [A]: () => appA, [B]: () => appB });

/** One of A's own feed situations, as its poll drafts it. */
function situationDraft(local: string) {
  return {
    id: `oc:situation:${SOURCE}:${local}`,
    class: "situation",
    kind: "incident",
    type: "obstruction",
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "moderate", source: "derived" },
    headline: [{ lang: "en", text: local }],
    validity: { status: "active", start: "2026-07-13T09:00:00Z" },
    effects: [],
    details: { kind: "incident", v: 1 },
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
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({ POSTGRES_DB: "a", POSTGRES_USER: "oc", POSTGRES_PASSWORD: "oc" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const server = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}`;
  const admin = postgres(`${server}/a`, { max: 1 });
  await admin.unsafe("CREATE DATABASE b");
  await admin.end();
  await runMigrations(`${server}/a`);
  await runMigrations(`${server}/b`);
  sqlA = postgres(`${server}/a`, { max: 4, onnotice: () => {} });
  sqlB = postgres(`${server}/b`, { max: 4, onnotice: () => {} });

  const now = new Date().toISOString();
  await ensureInstanceKey(sqlA, now);
  await ensureInstanceKey(sqlB, now);
  [keyA] = (await loadActiveKeys(sqlA, now)) as [InstanceKey];
  const [keyB] = (await loadActiveKeys(sqlB, now)) as [InstanceKey];

  const envA = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: A,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(actor(A)),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([peer(B, keyB)]),
  };
  const envB = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: B,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(actor(B)),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([peer(A, keyA, { subscribe: SUBSCRIBE })]),
  };
  settingsA = resolveFederationSettings(envA);
  settingsB = resolveFederationSettings(envB);
  appA = await build({ sql: sqlA, env: envA, logger: false });
  appB = await build({ sql: sqlB, env: envB, logger: false });

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
}, 180_000);

afterAll(async () => {
  await appA?.close();
  await appB?.close();
  await sqlA?.end();
  await sqlB?.end();
  await containerStop?.();
}, 30_000);

const subscriptionsAtA = () =>
  sqlA<{ peer_id: string; inbox_url: string; status: string; priority_only: boolean }[]>`
    SELECT peer_id, inbox_url, status, priority_only FROM conditions.federation_subscription`;

describe("two peered instances", () => {
  it("subscribes B at A from B's peers config, once", async () => {
    const [upkeep] = await refreshPeers(sqlB, settingsB, {
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
    const [again] = await refreshPeers(sqlB, settingsB, {
      fetchImpl,
      now: new Date().toISOString(),
    });
    expect(again!.subscription).toMatchObject({ ok: true, status: "unchanged" });
    // A subscribes to nobody.
    const [fromA] = await refreshPeers(sqlA, settingsA, {
      fetchImpl,
      now: new Date().toISOString(),
    });
    expect(fromA).toEqual({ peer: B, capabilities: expect.objectContaining({ ok: true }) });
  }, 60_000);

  it("lands at B what A publishes, and A's liveness of the source", async () => {
    const now = new Date().toISOString();
    await writeSnapshot(
      sqlA,
      SOURCE,
      { situations: [situationDraft("e2e-1")] },
      { registry, instanceId: A, now, complete: true },
    );
    await sqlA.begin((tx) => journalSourceLiveness(tx, SOURCE));

    const pushed = await runWebhookDeliveryCycle(sqlA, {
      signingKey: keyA,
      fetchImpl,
      partOf: `https://${A}/peer/outbox`,
    });
    expect(pushed).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });

    const [landed] = await sqlB<{ instance_id: string; revision: number }[]>`
      SELECT instance_id, revision FROM conditions.situation
       WHERE id = ${`oc:situation:${SOURCE}:e2e-1`}`;
    expect(landed).toEqual({ instance_id: A, revision: 1 });
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
    const [upkeep] = await refreshPeers(sqlB, settingsB, {
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
