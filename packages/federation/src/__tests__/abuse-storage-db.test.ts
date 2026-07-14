import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import {
  computePeerHealth,
  getPeerHealth,
  recordAvailability,
  recordPeerFailure,
  setEffectiveTierUntil,
} from "../peer-health.js";
import { blockPeer, isPeerBlocked, listBlockedPeers, unblockPeer } from "../peer-blocklist.js";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

const NOW = "2026-07-14T00:00:00.000Z";

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
  sql = postgres(url, { max: 3 });
  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("federation_peer_health storage", () => {
  it("records availability, signature, replay, schema and rate failures", async () => {
    const peer = "peer-health-1";
    await recordAvailability(sql, peer, true, NOW);
    await recordAvailability(sql, peer, true, NOW);
    await recordAvailability(sql, peer, false, NOW);
    await recordPeerFailure(sql, peer, "signature", NOW);
    await recordPeerFailure(sql, peer, "replay", NOW);
    await recordPeerFailure(sql, peer, "schema", NOW);
    await recordPeerFailure(sql, peer, "rate", NOW);
    await recordPeerFailure(sql, peer, "rate", NOW);

    const row = await getPeerHealth(sql, peer);
    expect(row).not.toBeNull();
    expect(row!.availabilityOk).toBe(2);
    expect(row!.availabilityFail).toBe(1);
    expect(row!.signatureFailures).toBe(1);
    expect(row!.replayFailures).toBe(1);
    expect(row!.schemaFailures).toBe(1);
    expect(row!.rateViolations).toBe(2);

    const health = computePeerHealth(row!);
    expect(health.score).toBeLessThan(1);
    expect(health.reasons).toContain("signature_failures");
    expect(health.reasons).toContain("rate_violations");
  });

  it("persists a transport-only effective-tier cooldown marker", async () => {
    const peer = "peer-health-2";
    const until = "2026-07-14T00:05:00.000Z";
    await setEffectiveTierUntil(sql, peer, until, NOW);
    const row = await getPeerHealth(sql, peer);
    expect(row!.effectiveTierUntil?.toISOString()).toBe(until);
  });

  it("returns null for a peer with no recorded activity", async () => {
    expect(await getPeerHealth(sql, "never-seen")).toBeNull();
  });
});

describe("federation_blocklist storage", () => {
  it("blocks, reports, lists and unblocks a peer", async () => {
    const peer = "peer-block-1";
    expect(await isPeerBlocked(sql, peer)).toBe(false);

    await blockPeer(sql, { peerId: peer, reason: "abuse", createdBy: "operator-a", now: NOW });
    expect(await isPeerBlocked(sql, peer)).toBe(true);

    const list = await listBlockedPeers(sql);
    const entry = list.find((b) => b.peerId === peer);
    expect(entry?.reason).toBe("abuse");
    expect(entry?.createdBy).toBe("operator-a");

    await unblockPeer(sql, peer);
    expect(await isPeerBlocked(sql, peer)).toBe(false);
  });

  it("re-blocking refreshes the reason and operator (idempotent)", async () => {
    const peer = "peer-block-2";
    await blockPeer(sql, { peerId: peer, reason: "first", createdBy: "op-1", now: NOW });
    await blockPeer(sql, { peerId: peer, reason: "second", createdBy: "op-2", now: NOW });
    const entry = (await listBlockedPeers(sql)).find((b) => b.peerId === peer);
    expect(entry?.reason).toBe("second");
    expect(entry?.createdBy).toBe("op-2");
  });
});
