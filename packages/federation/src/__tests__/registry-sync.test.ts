import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { guardedFetch } from "@openconditions/ingest-framework";
import { afterEach, describe, expect, it } from "vitest";
import type { PeerRecord } from "../peers.js";
import { mergePeerRecords, REGISTRY_SYNC_INTERVAL_HOURS, syncRegistry } from "../registry-sync.js";
import { TestRootInProductionError } from "../tuf/verify.js";
import {
  buildRepo,
  randomMultibase,
  sampleEntry,
  tempDir,
  writeRegistryDir,
} from "./tuf-fixture.js";

describe("syncRegistry", () => {
  it("verifies the TUF metadata and returns entries, peers, and a first-sync diff", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de"), sampleEntry("openmapx-nl")]);
    const repo = await buildRepo({ registryDir });
    const result = await syncRegistry(repo.repoDir, repo.rootBytes, {
      cacheDir: tempDir("oc-sync-cache-"),
      now: "2026-07-14T06:00:00.000Z",
    });
    expect(result.syncedAt).toBe("2026-07-14T06:00:00.000Z");
    expect(result.entries.map((entry) => entry.id)).toEqual(["openmapx-de", "openmapx-nl"]);
    expect(result.peers.map((peer) => peer.instanceId)).toEqual(["openmapx-de", "openmapx-nl"]);
    expect(result.peers[0]?.pinnedKeys).toEqual(result.entries[0]?.keys);
    expect(result.added).toEqual(["openmapx-de", "openmapx-nl"]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  it("reconciles the peer list across syncs: added, removed, changed, unchanged", async () => {
    const de = sampleEntry("openmapx-de");
    const nl = sampleEntry("openmapx-nl");
    const registryDir = writeRegistryDir([de, nl]);
    const repo = await buildRepo({ registryDir });
    const cacheDir = tempDir("oc-sync-cache-");
    const first = await syncRegistry(repo.repoDir, repo.rootBytes, { cacheDir });

    const rotatedNl = { ...nl, keys: [randomMultibase()] };
    const fr = sampleEntry("openmapx-fr");
    const updatedDir = writeRegistryDir([de, rotatedNl, fr]);
    await buildRepo({
      registryDir: updatedDir,
      repoDir: repo.repoDir,
      keys: repo.keys,
      version: 2,
    });

    const second = await syncRegistry(repo.repoDir, repo.rootBytes, {
      cacheDir,
      previousPeers: first.peers,
    });
    expect(second.added).toEqual(["openmapx-fr"]);
    expect(second.changed).toEqual(["openmapx-nl"]);
    expect(second.unchanged).toEqual(["openmapx-de"]);
    expect(second.removed).toEqual([]);

    const removedDir = writeRegistryDir([de]);
    await buildRepo({
      registryDir: removedDir,
      repoDir: repo.repoDir,
      keys: repo.keys,
      version: 3,
    });
    const third = await syncRegistry(repo.repoDir, repo.rootBytes, {
      cacheDir,
      previousPeers: second.peers,
    });
    expect(third.removed.sort()).toEqual(["openmapx-fr", "openmapx-nl"]);
    expect(third.unchanged).toEqual(["openmapx-de"]);
  });

  it("fails closed on a test root in production", async () => {
    const registryDir = writeRegistryDir([sampleEntry("openmapx-de")]);
    const repo = await buildRepo({ registryDir });
    await expect(
      syncRegistry(repo.repoDir, repo.rootBytes, {
        cacheDir: tempDir("oc-sync-cache-"),
        env: "production",
      }),
    ).rejects.toThrow(TestRootInProductionError);
  });

  it("documents the daily cadence, distinct from live-outbox polling", () => {
    expect(REGISTRY_SYNC_INTERVAL_HOURS).toBe(24);
  });
});

describe("syncRegistry over http, through a passed fetch", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  });

  /** Serves `repoDir` on localhost; a missing file is a 404, and `fail` paths answer 500. */
  async function serve(repoDir: string, fail: RegExp | null = null): Promise<string> {
    const server = createServer((req, res) => {
      const file = join(repoDir, decodeURIComponent(new URL(req.url!, "http://x").pathname));
      if (fail?.test(req.url!)) {
        res.statusCode = 500;
        res.end();
      } else if (!existsSync(file) || !statSync(file).isFile()) {
        res.statusCode = 404;
        res.end();
      } else {
        createReadStream(file).pipe(res);
      }
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return `http://localhost:${(server.address() as AddressInfo).port}`;
  }

  const source = (base: string) => ({
    metadataUrl: `${base}/metadata`,
    targetsUrl: `${base}/targets`,
  });
  const guard = (allowedHosts?: string[]) =>
    guardedFetch(undefined, {
      maxBytes: 10 * 1024 * 1024,
      timeoutMs: 10_000,
      maxRedirects: 2,
      ...(allowedHosts ? { allowedHosts: new Set(allowedHosts) } : {}),
    });

  it("verifies and reconciles across syncs as from a directory, a missing next root meaning none", async () => {
    const de = sampleEntry("openmapx-de");
    const nl = sampleEntry("openmapx-nl");
    const repo = await buildRepo({ registryDir: writeRegistryDir([de, nl]) });
    const base = await serve(repo.repoDir);
    const cacheDir = tempDir("oc-sync-cache-");
    const fetchImpl = guard(["localhost"]);
    const first = await syncRegistry(source(base), repo.rootBytes, { cacheDir, fetchImpl });
    expect(first.added).toEqual(["openmapx-de", "openmapx-nl"]);

    const fr = sampleEntry("openmapx-fr");
    await buildRepo({
      registryDir: writeRegistryDir([de, { ...nl, keys: [randomMultibase()] }, fr]),
      repoDir: repo.repoDir,
      keys: repo.keys,
      version: 2,
    });
    const second = await syncRegistry(source(base), repo.rootBytes, {
      cacheDir,
      previousPeers: first.peers,
      fetchImpl,
    });
    expect(second.added).toEqual(["openmapx-fr"]);
    expect(second.changed).toEqual(["openmapx-nl"]);
    expect(second.unchanged).toEqual(["openmapx-de"]);
  });

  it("is refused on a private address unless its host is allowed", async () => {
    const repo = await buildRepo({ registryDir: writeRegistryDir([sampleEntry("openmapx-de")]) });
    const base = await serve(repo.repoDir);
    await expect(
      syncRegistry(source(base), repo.rootBytes, {
        cacheDir: tempDir("oc-sync-cache-"),
        fetchImpl: guard(),
      }),
    ).rejects.toThrow(/private/);
  });

  it("fails on an answer other than 2xx or a missing root", async () => {
    const repo = await buildRepo({ registryDir: writeRegistryDir([sampleEntry("openmapx-de")]) });
    const base = await serve(repo.repoDir, /timestamp\.json$/);
    await expect(
      syncRegistry(source(base), repo.rootBytes, {
        cacheDir: tempDir("oc-sync-cache-"),
        fetchImpl: guard(["localhost"]),
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe("mergePeerRecords", () => {
  const bilateral: PeerRecord[] = [
    {
      instanceId: "openmapx-nl",
      actorUrl: "https://nl.example.org/.well-known/openconditions/actor.json",
      trustTier: 2,
      pinnedKeys: ["z6MkBilateralPin"],
    },
  ];

  it("unions registry-authorized keys into the bilateral pin set", () => {
    const discovered: PeerRecord[] = [
      {
        instanceId: "openmapx-nl",
        actorUrl: "https://nl.example.org/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: ["z6MkBilateralPin", "z6MkRegistryKey"],
      },
    ];
    const merged = mergePeerRecords(bilateral, discovered);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.pinnedKeys).toEqual(["z6MkBilateralPin", "z6MkRegistryKey"]);
  });

  it("keeps the operator's bilateral actorUrl and trust tier over the registry's", () => {
    const discovered: PeerRecord[] = [
      {
        instanceId: "openmapx-nl",
        actorUrl: "https://evil.example.org/actor.json",
        trustTier: 0,
        pinnedKeys: ["z6MkRegistryKey"],
      },
    ];
    const merged = mergePeerRecords(bilateral, discovered);
    expect(merged[0]?.actorUrl).toBe(bilateral[0]?.actorUrl);
    expect(merged[0]?.trustTier).toBe(2);
  });

  it("appends registry-only peers after the bilateral ones", () => {
    const discovered: PeerRecord[] = [
      {
        instanceId: "openmapx-de",
        actorUrl: "https://de.example.org/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: ["z6MkDeKey"],
      },
    ];
    const merged = mergePeerRecords(bilateral, discovered);
    expect(merged.map((peer) => peer.instanceId)).toEqual(["openmapx-nl", "openmapx-de"]);
  });

  it("works with an empty bilateral set (registry-only discovery)", () => {
    const discovered: PeerRecord[] = [
      {
        instanceId: "openmapx-de",
        actorUrl: "https://de.example.org/.well-known/openconditions/actor.json",
        trustTier: 1,
        pinnedKeys: ["z6MkDeKey"],
      },
    ];
    expect(mergePeerRecords([], discovered)).toEqual(discovered);
  });

  it("works with an empty registry (bilateral bootstrap needs no registry)", () => {
    expect(mergePeerRecords(bilateral, [])).toEqual(bilateral);
  });
});
