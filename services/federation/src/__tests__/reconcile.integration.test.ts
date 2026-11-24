/**
 * A subscriber comparing its copies with the publisher's present state, end
 * to end between two instances with their own databases and the real route
 * handlers: after an absence longer than its window (deletes and erasures are
 * in no archive) and after the publisher was restored to an older backup and
 * started a new epoch. Requests travel between the two apps in process.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestFederatedPage } from "@openconditions/contributions-api/federation/inbox";
import { runMigrations, SecretsKey } from "@openconditions/core/server";
import {
  ensureJournalEpoch,
  InMemoryNonceStore,
  type InstanceKey,
  loadActiveKeys,
  maintainInstanceKey,
  type RecordFilter,
} from "@openconditions/federation";
import { type RecordClass, schemaVersions, sealRecord } from "@openconditions/model";
import { type ArchivableRecord, recordArchiveBuffer } from "@openconditions/publishers";
import {
  seedFederation,
  syncSources,
  tombstoneRecords,
  writeSnapshot,
} from "@openconditions/storage";
import { TEST_SECRETS_KEY } from "@openconditions/test-database";
import {
  assertPostgisProfile,
  POSTGIS_IMAGES,
  postgisProfile,
} from "@openconditions/test-database/profile";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveFederationSettings } from "../config.js";
import { PeerBook } from "../peer-book.js";
import { refreshPeers } from "../peering.js";
import { pullPeer } from "../puller.js";
import { type ReconcileContext, reconcileAfter, reconcilePeer } from "../reconcile.js";
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
  capabilities: { protocolVersion: "0.3", convergenceBound: 300 },
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
  return new Response(new Uint8Array(res.rawPayload), { status: res.statusCode, headers });
}) as typeof fetch;

/** Serves A's archive directory, as the operator's file server does. */
const archiveServer: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host !== A || !url.pathname.startsWith("/archive/")) {
    return new Response("", { status: 404 });
  }
  const file = path.join(archiveDir, decodeURIComponent(path.basename(url.pathname)));
  return new Response(new Uint8Array(await readFile(file)), { status: 200 });
};

function incident(local: string, headline = local, validityEnd?: string) {
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
    validity: {
      status: "active",
      start: "2026-07-13T09:00:00Z",
      ...(validityEnd !== undefined ? { end: validityEnd } : {}),
    },
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

/** Writes A's own records as its poll does. */
const writeAtA = (drafts: Record<string, unknown>[]) =>
  writeSnapshot(
    sqlA,
    SOURCE,
    { situations: drafts },
    { registry, instanceId: A, now: new Date().toISOString(), complete: false },
  );

/** Ends A's records with `reason`, as its sweep or an erasure does. */
const endAtA = (locals: string[], reason: string) =>
  sqlA.begin((tx) =>
    tombstoneRecords(tx, "situation", locals.map(idOf), reason, {
      registry,
      now: new Date().toISOString(),
    }),
  );

/** A's record sealed by A at `revision`, as a restored backup holds it. */
function sealedAtA(local: string, revision: number, recordedAt: string, headline: string) {
  const sealed = sealRecord(registry, incident(local, headline), {
    instanceId: A,
    revision,
    recordedAt,
  });
  if (!sealed.ok) throw new Error(JSON.stringify(sealed.issues));
  return sealed.value;
}

/** Puts A's row of `local` back to the version an older backup holds, its history with it. */
async function restoreAtA(local: string, revision: number, recordedAt: string, headline: string) {
  const record = sealedAtA(local, revision, recordedAt, headline);
  await sqlA`
    DELETE FROM conditions.situation_revision
     WHERE situation_id = ${idOf(local)} AND revision > ${revision}`;
  await sqlA`
    UPDATE conditions.situation
       SET record = ${sqlA.json(record as never)}, revision = ${revision},
           recorded_at = ${recordedAt}, content_hash = ${record["contentHash"] as string},
           tombstone_reason = NULL, tombstoned_at = NULL
     WHERE id = ${idOf(local)}`;
}

/** Writes A's archive of what it holds now, leaving out situations whose validity ended. */
async function buildArchive(builtAt: string): Promise<void> {
  const day = builtAt.slice(0, 10);
  for (const cls of ["situation", "feature", "offer", "observation"] as RecordClass[]) {
    const records =
      cls === "situation"
        ? (
            await sqlA<{ record: ArchivableRecord }[]>`
              SELECT record FROM conditions.situation
               WHERE tombstoned_at IS NULL
                 AND (record #>> '{validity,end}' IS NULL
                      OR (record #>> '{validity,end}')::timestamptz > now())`
          ).map((r) => r.record)
        : [];
    const name = `archive-${cls}-${day}.parquet`;
    const content = recordArchiveBuffer(cls, records, builtAt);
    await writeFile(path.join(archiveDir, name), content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    await sqlA`
      INSERT INTO conditions.archive_file (record_class, file_name, sha256, bytes, built_at)
      VALUES (${cls}, ${name}, ${sha256}, ${content.byteLength}, ${builtAt})
      ON CONFLICT (record_class) DO UPDATE SET file_name = excluded.file_name,
        sha256 = excluded.sha256, bytes = excluded.bytes, built_at = excluded.built_at`;
  }
}

const peerA = () => ({ ...peersD.find(A)!, pull: { filter: FILTER } });

const pull = () =>
  pullPeer(sqlD, peerA(), {
    registry,
    localInstanceId: D,
    signingKey: keyD,
    fetchImpl,
    archiveFetch: archiveServer,
    nonceStore: new InMemoryNonceStore(),
    now: () => new Date().toISOString(),
  });

const reconcile = (over: Partial<ReconcileContext> = {}) =>
  reconcilePeer(sqlD, peerA(), {
    registry,
    localInstanceId: D,
    signingKey: keyD,
    fetchImpl,
    nonceStore: new InMemoryNonceStore(),
    now: () => new Date().toISOString(),
    ...over,
  });

interface Copy {
  revision: number;
  recorded_at: Date;
  tombstone_reason: string | null;
  headline: string | null;
}

const copyAt = async (sql: postgres.Sql, local: string): Promise<Copy | undefined> =>
  (
    await sql<Copy[]>`
      SELECT revision, recorded_at, tombstone_reason, record #>> '{headline,0,text}' AS headline
        FROM conditions.situation WHERE id = ${idOf(local)}`
  )[0];

const due = async () =>
  (
    await sqlD<
      {
        reconcile_due_since: Date | null;
        reconcile_class: string | null;
        reconcile_after: string | null;
        reconciled_at: Date | null;
      }[]
    >`
      SELECT reconcile_due_since, reconcile_class, reconcile_after, reconciled_at
        FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${A}`
  )[0];

/** Makes a comparison due, as an operator can. */
const makeDue = () => sqlD`
  UPDATE conditions.federation_peer_cursor
     SET reconcile_due_since = now(), reconcile_class = NULL, reconcile_after = NULL
   WHERE peer_instance_id = ${A}`;

/** A fetch that records what it is asked and lets `before` act first. */
function watching(before?: (url: URL, init?: RequestInit) => Promise<Response | undefined>) {
  const asked: { method: string; url: URL; body?: string }[] = [];
  const fetchWatched = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    asked.push({
      method: init?.method ?? "GET",
      url,
      ...(init?.body ? { body: Buffer.from(init.body as Buffer).toString("utf8") } : {}),
    });
    return (await before?.(url, init)) ?? fetchImpl(input, init);
  }) as typeof fetch;
  return { fetchWatched, asked };
}

beforeAll(async () => {
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
      fixture: "reconcile.integration.test.ts",
      containerId: container.getId(),
    });
    await admin.unsafe("CREATE DATABASE d");
  } finally {
    await admin.end();
  }
  await runMigrations(`${server}/a`);
  await runMigrations(`${server}/d`);
  sqlA = postgres(`${server}/a`, { max: 4, onnotice: () => {} });
  sqlD = postgres(`${server}/d`, { max: 4, onnotice: () => {} });
  archiveDir = await mkdtemp(path.join(tmpdir(), "oc-reconcile-test-"));

  const now = new Date().toISOString();
  const secrets = SecretsKey.parse(TEST_SECRETS_KEY);
  await maintainInstanceKey(sqlA, secrets, now, A);
  await maintainInstanceKey(sqlD, secrets, now, D);
  const [keyA] = (await loadActiveKeys(sqlA, secrets, now)) as [InstanceKey];
  [keyD] = (await loadActiveKeys(sqlD, secrets, now)) as [InstanceKey];

  const envA = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_SECRETS_KEY: TEST_SECRETS_KEY,
    OPENCONDITIONS_INSTANCE_ID: A,
    OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify(actor(A)),
    OPENCONDITIONS_FEDERATION_PEERS: JSON.stringify([peer(D, keyD)]),
    OPENCONDITIONS_FEDERATION_ARCHIVE_URL: ARCHIVE_URL,
  };
  const envD = {
    OPENCONDITIONS_FEDERATION_ENABLED: "true",
    OPENCONDITIONS_SECRETS_KEY: TEST_SECRETS_KEY,
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
  // D subscribes to pull, which has A journal what it wants, and records the
  // protocol version the two negotiated.
  const [upkeep] = await refreshPeers(sqlD, settingsD, peersD, { fetchImpl, now });
  expect(upkeep).toMatchObject({ pullSubscription: { ok: true, status: "created" } });
  const [negotiated] = await sqlD<{ protocol_version: string }[]>`
    SELECT protocol_version FROM conditions.federation_peer_capabilities`;
  expect(negotiated?.protocol_version).toBe("0.3");
}, 180_000);

afterAll(async () => {
  await appA?.close();
  await appD?.close();
  await sqlA?.end();
  await sqlD?.end();
  await containerStop?.();
  if (archiveDir) await rm(archiveDir, { recursive: true, force: true });
}, 30_000);

describe("a subscriber away longer than its window", () => {
  it("ends what the publisher withdrew or erased meanwhile, and gets what the archive leaves out", async () => {
    await writeAtA([incident("abs-keep"), incident("abs-withdrawn"), incident("abs-erased")]);
    const first = await pull();
    expect(first).toMatchObject({ accepted: 3, more: false });
    expect(first.error).toBeUndefined();
    expect((await due())?.reconcile_due_since).toBeNull();
    const kept = await copyAt(sqlD, "abs-keep");

    // While D is away: one record withdrawn, one erased, two created, one of
    // them already over (the archive leaves it out).
    await endAtA(["abs-withdrawn"], "withdrawn");
    await endAtA(["abs-erased"], "rights_revoked");
    const over = new Date(Date.now() - DAY).toISOString();
    await writeAtA([incident("abs-new"), incident("abs-over", "abs-over", over)]);
    // All of it was journalled before D's window; the archive was built since.
    await sqlA`UPDATE conditions.federation_outbox SET created_at = now() - interval '40 days'`;
    await buildArchive(new Date(Date.now() - DAY).toISOString());

    const back = await pull();
    expect(back).toMatchObject({ beyondWindow: true, more: false });
    expect(back.error).toBeUndefined();
    expect(back.archive?.accepted).toBeGreaterThanOrEqual(1);
    expect((await due())?.reconcile_due_since).not.toBeNull();
    // The pull alone left both copies live.
    expect((await copyAt(sqlD, "abs-withdrawn"))?.tombstone_reason).toBeNull();
    expect((await copyAt(sqlD, "abs-erased"))?.tombstone_reason).toBeNull();
    expect(await copyAt(sqlD, "abs-over")).toBeUndefined();

    expect(reconcileAfter(back)).toBe(true);
    const result = await reconcile();
    expect(result).toMatchObject({
      status: "finished",
      counts: { updated: 1, ended: 2, retired: 0, refused: 0, restored: 0 },
    });

    expect(await copyAt(sqlD, "abs-withdrawn")).toMatchObject({ tombstone_reason: "withdrawn" });
    const erased = await copyAt(sqlD, "abs-erased");
    expect(erased).toMatchObject({ tombstone_reason: "rights_revoked", headline: null });
    const [fact] = await sqlD`
      SELECT peer_instance_id FROM conditions.federation_tombstone
       WHERE canonical_id = (SELECT canonical_id FROM conditions.situation
                              WHERE id = ${idOf("abs-erased")})`;
    expect(fact).toEqual({ peer_instance_id: A });
    expect(await copyAt(sqlD, "abs-over")).toMatchObject({ tombstone_reason: null });
    expect(await copyAt(sqlD, "abs-over")).toEqual(await copyAt(sqlA, "abs-over"));
    expect(await copyAt(sqlD, "abs-new")).toMatchObject({ tombstone_reason: null });
    expect(await copyAt(sqlD, "abs-keep")).toEqual(kept);
    const after = await due();
    expect(after).toMatchObject({ reconcile_due_since: null, reconcile_class: null });
    expect(after?.reconciled_at).not.toBeNull();
    expect(await reconcile()).toEqual({ status: "none" });
  }, 60_000);
});

describe("a publisher restored to an older backup", () => {
  it("brings every copy to the publisher's present state", async () => {
    // The history D receives.
    await writeAtA(["rs-a", "rs-b", "rs-c", "rs-d", "rs-e"].map((l) => incident(l)));
    await writeAtA([incident("rs-b", "b two"), incident("rs-c", "c two")]);
    await writeAtA([incident("rs-c", "c three")]);
    await endAtA(["rs-d"], "withdrawn");
    expect((await pull()).error).toBeUndefined();
    expect(await copyAt(sqlD, "rs-c")).toMatchObject({ revision: 3, headline: "c three" });
    expect(await copyAt(sqlD, "rs-d")).toMatchObject({
      revision: 2,
      tombstone_reason: "withdrawn",
    });
    const e = await copyAt(sqlD, "rs-e");
    const eHistory = async () =>
      sqlD`SELECT revision, recorded_at FROM conditions.situation_revision
            WHERE situation_id = ${idOf("rs-e")} ORDER BY revision`;
    const eRevisions = await eHistory();

    // A goes back to a backup: rs-a never existed there, rs-b is at the same
    // revision with other content, rs-c at a lower one, rs-d still live.
    const restoredAt = new Date(Date.now() - 3 * DAY).toISOString();
    await sqlA`DELETE FROM conditions.situation WHERE id = ${idOf("rs-a")}`;
    await restoreAtA("rs-b", 2, restoredAt, "b restored");
    await restoreAtA("rs-c", 2, restoredAt, "c restored");
    await restoreAtA("rs-d", 1, restoredAt, "d restored");
    // The backup's journal held none of what came after it; the operator asks
    // for a new epoch and the boot journals the records again.
    await sqlA`DELETE FROM conditions.federation_outbox`;
    await sqlA`DELETE FROM conditions.federation_journal`;
    await ensureJournalEpoch(sqlA, { now: new Date().toISOString() });
    await seedFederation(sqlA);

    const reread = await pull();
    expect(reread).toMatchObject({ reset: "epoch", more: false });
    expect(reread.error).toBeUndefined();
    // Read again, the journal changes none of the copies.
    expect(await copyAt(sqlD, "rs-c")).toMatchObject({ revision: 3, headline: "c three" });
    expect((await due())?.reconcile_due_since).not.toBeNull();

    const result = await reconcile();
    expect(result).toMatchObject({
      status: "finished",
      counts: { updated: 2, restored: 1, retired: 1, ended: 0, refused: 0 },
    });
    expect(await copyAt(sqlD, "rs-a")).toMatchObject({
      revision: 1,
      tombstone_reason: "withdrawn",
    });
    for (const local of ["rs-b", "rs-c", "rs-d"]) {
      expect(await copyAt(sqlD, local), local).toEqual(await copyAt(sqlA, local));
      expect((await copyAt(sqlD, local))?.tombstone_reason, local).toBeNull();
    }
    expect(await copyAt(sqlD, "rs-e")).toEqual(e);
    expect(await eHistory()).toEqual(eRevisions);

    // From here on the publisher's ordinary updates land.
    await writeAtA(["rs-b", "rs-c", "rs-d"].map((l) => incident(l, `${l} later`)));
    const later = await pull();
    expect(later).toMatchObject({ accepted: 3 });
    for (const local of ["rs-b", "rs-c", "rs-d"]) {
      expect(await copyAt(sqlD, local), local).toEqual(await copyAt(sqlA, local));
    }
  }, 60_000);
});

describe("landing the publisher's answers", () => {
  it("never overwrites a newer version a push landed after the comparison", async () => {
    await writeAtA([incident("cc-x")]);
    expect((await pull()).error).toBeUndefined();
    await restoreAtA("cc-x", 2, new Date(Date.now() - DAY).toISOString(), "cc restated");
    await makeDue();
    const peerVersions = schemaVersions(registry);
    const pushed = sealedAtA("cc-x", 3, new Date().toISOString(), "cc pushed");
    const { fetchWatched } = watching(async (url) => {
      if (url.pathname !== "/peer/records") return undefined;
      // A push of a newer revision lands while the answer is on its way.
      await ingestFederatedPage(
        sqlD,
        {
          orderedItems: [
            {
              seq: 1,
              txid: "1",
              operation: "update",
              recordClass: "situation",
              recordId: idOf("cc-x"),
              canonicalId: pushed["canonicalId"],
              kind: "incident",
              domain: "roads",
              createdAt: new Date().toISOString(),
              record: pushed,
            },
          ],
        },
        {
          registry,
          localInstanceId: D,
          peerInstanceId: A,
          peerVersions,
          now: new Date().toISOString(),
        },
      );
      return undefined;
    });
    const result = await reconcile({ fetchImpl: fetchWatched });
    expect(result).toMatchObject({ status: "finished", counts: { updated: 0 } });
    expect(await copyAt(sqlD, "cc-x")).toMatchObject({ revision: 3, headline: "cc pushed" });
  }, 60_000);
});

describe("a comparison over several rounds", () => {
  it("resumes from its stored progress after its time slice", async () => {
    await makeDue();
    let clock = Date.now();
    const ticking = watching(async () => {
      clock += 10_000;
      return undefined;
    });
    const now = () => new Date(clock).toISOString();
    const first = await reconcile({ fetchImpl: ticking.fetchWatched, now, sliceMs: 15_000 });
    expect(first.status).toBe("more");
    const stored = await due();
    expect(stored?.reconcile_due_since).not.toBeNull();
    expect(stored?.reconcile_class).toBe("offer");

    const rest = watching();
    expect((await reconcile({ fetchImpl: rest.fetchWatched })).status).toBe("finished");
    expect(rest.asked[0]?.url.searchParams.get("class")).toBe("offer");
    expect((await due())?.reconcile_due_since).toBeNull();
  }, 60_000);

  it("waits out a peer that asks it to retry later, then goes on where it stopped", async () => {
    await makeDue();
    let refused = false;
    const throttled = watching(async (url) => {
      if (refused || url.searchParams.get("class") !== "situation") return undefined;
      refused = true;
      return new Response("{}", { status: 429, headers: { "retry-after": "5" } });
    });
    const first = await reconcile({ fetchImpl: throttled.fetchWatched });
    expect(first).toMatchObject({ status: "stopped", retryAfterSec: 5 });
    expect((await due())?.reconcile_class).toBe("situation");

    const rest = watching();
    expect((await reconcile({ fetchImpl: rest.fetchWatched })).status).toBe("finished");
    expect(rest.asked[0]?.url.searchParams.get("class")).toBe("situation");
  }, 60_000);

  it("starts over when the peer's journal starts over during it", async () => {
    await makeDue();
    const resetting = watching(async (url) => {
      if (url.searchParams.get("class") === "situation") {
        await sqlD`
          UPDATE conditions.federation_peer_cursor
             SET reconcile_due_since = now() + interval '1 second',
                 reconcile_class = NULL, reconcile_after = NULL
           WHERE peer_instance_id = ${A}`;
      }
      return undefined;
    });
    expect((await reconcile({ fetchImpl: resetting.fetchWatched })).status).toBe("more");
    const again = watching();
    expect((await reconcile({ fetchImpl: again.fetchWatched })).status).toBe("finished");
    expect(again.asked[0]?.url.searchParams.get("class")).toBe("feature");
  }, 60_000);

  it("stops at a listing of another epoch, changing nothing", async () => {
    await writeAtA([incident("ep-new")]);
    await makeDue();
    const [{ journal_epoch: epoch }] = await sqlD<{ journal_epoch: string }[]>`
      SELECT journal_epoch FROM conditions.federation_peer_cursor WHERE peer_instance_id = ${A}`;
    await sqlD`
      UPDATE conditions.federation_peer_cursor SET journal_epoch = 'another-history'
       WHERE peer_instance_id = ${A}`;
    try {
      expect(await reconcile()).toMatchObject({
        status: "stopped",
        error: "the peer's journal epoch changed",
      });
      expect(await copyAt(sqlD, "ep-new")).toBeUndefined();
      expect((await due())?.reconcile_due_since).not.toBeNull();
    } finally {
      await sqlD`
        UPDATE conditions.federation_peer_cursor SET journal_epoch = ${epoch}
         WHERE peer_instance_id = ${A}`;
    }
  }, 60_000);
});

describe("when a comparison runs", () => {
  it("is not due after an ordinary pull, and waits while the pull has more to read", async () => {
    await sqlD`
      UPDATE conditions.federation_peer_cursor
         SET reconcile_due_since = NULL, reconcile_class = NULL, reconcile_after = NULL
       WHERE peer_instance_id = ${A}`;
    await writeAtA([incident("ordinary")]);
    const ordinary = await pull();
    expect(ordinary).toMatchObject({ more: false });
    expect(ordinary.beyondWindow).toBeUndefined();
    expect((await due())?.reconcile_due_since).toBeNull();
    expect(await reconcile()).toEqual({ status: "none" });
    expect(reconcileAfter({ ...ordinary, more: true })).toBe(false);
    expect(reconcileAfter({ ...ordinary, error: "the peer could not be reached" })).toBe(false);
  }, 60_000);

  it("stays due against a peer that does not speak the protocol version with the routes", async () => {
    await makeDue();
    await sqlD`UPDATE conditions.federation_peer_capabilities SET protocol_version = '0.2'`;
    try {
      expect(await reconcile()).toEqual({ status: "unsupported", protocolVersion: "0.2" });
      expect((await due())?.reconcile_due_since).not.toBeNull();
    } finally {
      await sqlD`UPDATE conditions.federation_peer_capabilities SET protocol_version = '0.3'`;
    }
  }, 60_000);
});
