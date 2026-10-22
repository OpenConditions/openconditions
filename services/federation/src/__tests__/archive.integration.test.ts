/**
 * A peer that starts pulling, or returns, beyond the publisher's live window:
 * it lands the publisher's archive, checked against the signed page, before
 * the pages that carry what changed since the archive's night.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrations } from "@openconditions/core/server";
import {
  createInMemoryRateLimiter,
  InMemoryNonceStore,
  type InstanceKey,
  loadActiveKeys,
  maintainInstanceKey,
  type RecordFilter,
} from "@openconditions/federation";
import type { RecordClass } from "@openconditions/model";
import { type ArchivableRecord, recordArchiveBuffer } from "@openconditions/publishers";
import {
  seedFederation,
  syncSources,
  tombstoneRecords,
  writeSnapshot,
} from "@openconditions/storage";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveFederationSettings } from "../config.js";
import { PeerBook } from "../peer-book.js";
import { refreshPeers } from "../peering.js";
import { pullPeer } from "../puller.js";
import { build } from "../server.js";
import { registry } from "./record-fixtures.js";

const A = "a.example.org";
const D = "d.example.org";
const SOURCE = "nl-ndw-events";
const ARCHIVE_URL = `https://${A}/archive`;
const DAY = 86_400_000;

let containerStop: () => Promise<unknown>;
let sqlA: postgres.Sql;
let sqlD: postgres.Sql;
let keyD: InstanceKey;
let appA: FastifyInstance;
let appD: FastifyInstance;
let peersD: PeerBook;
let archiveDir: string;

const FILTER: RecordFilter = { classes: ["situation"], domains: ["roads"], kinds: ["incident"] };

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

/** Carries a request to the app serving its host, as the network would. */
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const app = { [A]: appA, [D]: appD }[url.host];
  if (app === undefined) throw new TypeError(`fetch failed: no route to ${url.host}`);
  const res = await app.inject({
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

/** Serves A's archive directory, as the operator's file server does; `alter` tampers. */
const archiveServer =
  (alter: (bytes: Buffer) => Buffer = (b) => b): typeof fetch =>
  async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== A || !url.pathname.startsWith("/archive/")) {
      return new Response("", { status: 404 });
    }
    const file = path.join(archiveDir, decodeURIComponent(path.basename(url.pathname)));
    return new Response(new Uint8Array(alter(await readFile(file))), { status: 200 });
  };

function incident(local: string, headline = local) {
  return {
    id: `oc:situation:${SOURCE}:${local}`,
    class: "situation",
    kind: "incident",
    type: "obstruction",
    temporality: "live",
    planned: false,
    certainty: "observed",
    severity: { label: "moderate", source: "derived" },
    headline: [{ lang: "en", text: headline }],
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

const idOf = (local: string) => `oc:situation:${SOURCE}:${local}`;

/** Writes A's archive of what it holds now, as the ingest's nightly build does. */
async function buildArchive(builtAt: string): Promise<void> {
  const day = builtAt.slice(0, 10);
  for (const cls of ["situation", "feature", "offer", "observation"] as RecordClass[]) {
    const records =
      cls === "situation"
        ? (
            await sqlA<{ record: ArchivableRecord }[]>`
              SELECT record FROM conditions.situation WHERE tombstoned_at IS NULL`
          ).map((r) => r.record)
        : [];
    const name = `archive-${cls}-${day}.parquet`;
    const content = recordArchiveBuffer(cls, records, builtAt);
    await writeFile(path.join(archiveDir, name), content);
    const bytes = content.byteLength;
    const sha256 = createHash("sha256").update(content).digest("hex");
    await sqlA`
      INSERT INTO conditions.archive_file (record_class, file_name, sha256, bytes, built_at)
      VALUES (${cls}, ${name}, ${sha256}, ${bytes}, ${builtAt})
      ON CONFLICT (record_class) DO UPDATE SET file_name = excluded.file_name,
        sha256 = excluded.sha256, bytes = excluded.bytes, built_at = excluded.built_at`;
  }
}

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({ POSTGRES_DB: "a", POSTGRES_USER: "oc", POSTGRES_PASSWORD: "oc" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  containerStop = () => container.stop();
  const server = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}`;
  const admin = postgres(`${server}/a`, { max: 1 });
  await admin.unsafe("CREATE DATABASE d");
  await admin.end();
  await runMigrations(`${server}/a`);
  await runMigrations(`${server}/d`);
  sqlA = postgres(`${server}/a`, { max: 4, onnotice: () => {} });
  sqlD = postgres(`${server}/d`, { max: 4, onnotice: () => {} });
  archiveDir = await mkdtemp(path.join(tmpdir(), "oc-archive-test-"));

  const now = new Date().toISOString();
  await maintainInstanceKey(sqlA, now, A);
  await maintainInstanceKey(sqlD, now, D);
  const [keyA] = (await loadActiveKeys(sqlA, now)) as [InstanceKey];
  [keyD] = (await loadActiveKeys(sqlD, now)) as [InstanceKey];

  const envA = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: A,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(actor(A)),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([peer(D, keyD)]),
    OPENCONDITIONS_FEDERATION_ARCHIVE_URL: ARCHIVE_URL,
  };
  const envD = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_INSTANCE_ID: D,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(actor(D)),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([peer(A, keyA, { pull: { filter: FILTER } })]),
  };
  appA = await build({ sql: sqlA, env: envA, logger: false });
  const settingsD = resolveFederationSettings(envD);
  peersD = await PeerBook.load(sqlD, settingsD.peers);
  appD = await build({ sql: sqlD, env: envD, logger: false, peers: peersD });

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
  await writeSnapshot(
    sqlA,
    SOURCE,
    { situations: [incident("ancient"), incident("changed"), incident("gone")] },
    { registry, instanceId: A, now, complete: true },
  );
  // D subscribes to pull, which has A journal its records (A's seed).
  const [upkeep] = await refreshPeers(sqlD, settingsD, peersD, { fetchImpl, now });
  expect(upkeep).toMatchObject({ pullSubscription: { ok: true, status: "created" } });
  await seedFederation(sqlA);
  // All of it was journalled long ago: before D's 30-day window.
  await sqlA`UPDATE conditions.federation_outbox SET created_at = now() - interval '40 days'`;
  await buildArchive(new Date(Date.now() - DAY).toISOString());
  // Since the archive's night: one record changed, one was withdrawn.
  await writeSnapshot(
    sqlA,
    SOURCE,
    { situations: [incident("changed", "changed since")] },
    { registry, instanceId: A, now: new Date().toISOString(), complete: false },
  );
  await sqlA.begin((tx) =>
    tombstoneRecords(tx, "situation", [idOf("gone")], "withdrawn", {
      registry,
      now: new Date().toISOString(),
    }),
  );
}, 180_000);

afterAll(async () => {
  await appA?.close();
  await appD?.close();
  await sqlA?.end();
  await sqlD?.end();
  await containerStop?.();
  if (archiveDir) await rm(archiveDir, { recursive: true, force: true });
}, 30_000);

const pull = (archiveFetch: typeof fetch) =>
  pullPeer(
    sqlD,
    { ...peersD.find(A)!, pull: { filter: FILTER } },
    {
      registry,
      localInstanceId: D,
      signingKey: keyD,
      fetchImpl,
      archiveFetch,
      nonceStore: new InMemoryNonceStore(),
      rateLimiter: createInMemoryRateLimiter(),
      now: () => new Date().toISOString(),
    },
  );

const atD = async () =>
  Object.fromEntries(
    (
      await sqlD<{ id: string; revision: number; tombstone_reason: string | null }[]>`
        SELECT id, revision, tombstone_reason FROM conditions.situation ORDER BY id`
    ).map((r) => [r.id.slice(r.id.lastIndexOf(":") + 1), [r.revision, r.tombstone_reason]]),
  );

describe("a peer beyond the publisher's window", () => {
  it("lands nothing of an archive file that is not the one the signed page states", async () => {
    const tampered = await pull(archiveServer((bytes) => Buffer.concat([bytes, Buffer.from("x")])));
    expect(tampered.error).toMatch(/is larger than the page states|is not the one the page states/);
    expect(await atD()).toEqual({});
    expect(await sqlD`SELECT 1 FROM conditions.federation_peer_cursor`).toHaveLength(0);
  }, 60_000);

  it("lands the archive, then what changed since its night", async () => {
    const result = await pull(archiveServer());
    expect(result.error).toBeUndefined();
    expect(result.beyondWindow).toBe(true);
    expect(result.archive).toMatchObject({ accepted: 3, skipped: 0 });
    expect(await atD()).toEqual({
      // Only the archive still holds it.
      ancient: [1, null],
      changed: [2, null],
      gone: [2, "withdrawn"],
    });

    // The cursor is past the window's start: the next pull reads no archive.
    const again = await pull(archiveServer(() => Buffer.from("not read")));
    expect(again.error).toBeUndefined();
    expect(again.archive).toBeUndefined();
  }, 60_000);
});
