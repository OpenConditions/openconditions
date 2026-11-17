import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  generateInstanceKey,
  generateTufSigner,
  signRegistry,
  type TufRoleConfig,
  type TufRoleName,
} from "@openconditions/federation";
import { afterEach, describe, expect, it } from "vitest";
import type { RegistrySettings } from "../config.js";
import { PeerBook } from "../peer-book.js";
import { RegistryDiscovery, VERIFIED_PEERS_FILE } from "../registry.js";

const NOW = "2026-11-17T12:00:00.000Z";

interface StoredFile {
  syncedAt: string;
  targetsExpires: string;
  rootSha256: string;
  peers: { instanceId: string }[];
}
const SELF = "me.example.org";

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = async (id: string) => ({
  id,
  actor: `https://${id}/.well-known/openconditions/actor.json`,
  operator: { name: `Operator of ${id}`, contact: `federation@${id}`, jurisdiction: "DE" },
  coverage: { iso3166: ["DE"] },
  trustTier: 1,
  keys: [(await generateInstanceKey(NOW)).keyId],
});

/** Signs a registry of `ids` (YAML being a superset of JSON, each entry is written as JSON). */
async function sign(
  repoDir: string,
  roles: Record<TufRoleName, TufRoleConfig>,
  ids: string[],
  version = 1,
) {
  const registryDir = tempDir("oc-registry-");
  for (const id of ids) {
    writeFileSync(join(registryDir, `${id}.yaml`), JSON.stringify(await entry(id)));
  }
  return signRegistry({ registryDir, repoDir, roles, version, testRoot: true });
}

/** A signed registry of `ids`, and settings that read it from disk. */
async function registryOf(ids: string[]) {
  const repoDir = tempDir("oc-registry-repo-");
  const role = async (): Promise<TufRoleConfig> => {
    const signer = await generateTufSigner();
    return { keys: [signer.key], threshold: 1, signers: [signer] };
  };
  const roles: Record<TufRoleName, TufRoleConfig> = {
    root: await role(),
    targets: await role(),
    snapshot: await role(),
    timestamp: await role(),
  };
  const signed = await sign(repoDir, roles, ids);
  const settings: RegistrySettings = {
    metadataUrl: pathToFileURL(join(repoDir, "metadata")).href,
    targetsUrl: pathToFileURL(join(repoDir, "targets")).href,
    root: signed.rootBytes.toString("utf8"),
    cacheDir: tempDir("oc-registry-cache-"),
  };
  return { settings, repoDir, roles };
}

/** A registry whose metadata cannot be fetched, sharing `cacheDir`. */
const unreachable = (settings: RegistrySettings): RegistrySettings => ({
  ...settings,
  metadataUrl: pathToFileURL(join(tempDir("oc-registry-gone-"), "metadata")).href,
  targetsUrl: pathToFileURL(join(tempDir("oc-registry-gone-"), "targets")).href,
});

const noFetch = (async () => {
  throw new Error("the registry is read from disk here");
}) as unknown as typeof fetch;

describe("the registry discovery", () => {
  it("leaves this instance's own entry out of what it reports", async () => {
    const { settings } = await registryOf(["a.example.org", SELF, "b.example.org"]);
    const book = new PeerBook([]);
    const discovery = new RegistryDiscovery(book, settings, SELF, noFetch);
    const first = await discovery.sync(NOW);
    expect(first).toMatchObject({
      added: ["a.example.org", "b.example.org"],
      removed: [],
      changed: [],
    });
    expect(book.all().map((peer) => peer.instanceId)).toEqual(["a.example.org", "b.example.org"]);
    // A second sync of the same registry reports nothing, the tier the
    // registry states included, though the book serves those peers tier 0.
    expect(await discovery.sync(NOW)).toMatchObject({ added: [], removed: [], changed: [] });
  });

  it("stores each verified sync's peers and takes them back when the first sync after boot fails", async () => {
    const { settings } = await registryOf(["a.example.org", SELF]);
    await new RegistryDiscovery(new PeerBook([]), settings, SELF, noFetch).sync(NOW);
    const file = join(settings.cacheDir, VERIFIED_PEERS_FILE);
    const stored = JSON.parse(readFileSync(file, "utf8")) as StoredFile;
    expect(stored.syncedAt).toBe(NOW);
    expect(stored.peers.map((peer) => peer.instanceId)).toEqual(["a.example.org"]);
    // Bounded by the verified targets metadata, under the root configured.
    const targets = JSON.parse(readFileSync(join(settings.cacheDir, "targets.json"), "utf8")) as {
      signed: { expires: string };
    };
    expect(stored.targetsExpires).toBe(new Date(targets.signed.expires).toISOString());
    expect(stored.rootSha256).toBe(createHash("sha256").update(settings.root).digest("hex"));

    // The next process starts while the registry cannot be reached.
    const book = new PeerBook([]);
    const discovery = new RegistryDiscovery(book, unreachable(settings), SELF, noFetch);
    await expect(discovery.sync(NOW)).rejects.toThrow();
    expect(await discovery.restore(NOW)).toEqual({
      status: "restored",
      peers: 1,
      syncedAt: NOW,
      file,
    });
    expect(book.all().map((peer) => peer.instanceId)).toEqual(["a.example.org"]);
    // Only once.
    expect(await discovery.restore(NOW)).toEqual({ status: "not-needed" });
  });

  it("does not take the stored peers back past the targets expiry, without one, or under another root", async () => {
    const { settings } = await registryOf(["a.example.org"]);
    await new RegistryDiscovery(new PeerBook([]), settings, SELF, noFetch).sync(NOW);
    const file = join(settings.cacheDir, VERIFIED_PEERS_FILE);
    const stored = JSON.parse(readFileSync(file, "utf8")) as StoredFile;
    const gone = unreachable(settings);
    const restoreAt = async (now: string, over: RegistrySettings = gone) => {
      const book = new PeerBook([]);
      const outcome = await new RegistryDiscovery(book, over, SELF, noFetch).restore(now);
      return { outcome, peers: book.all().map((peer) => peer.instanceId) };
    };

    const justBefore = new Date(Date.parse(stored.targetsExpires) - 1000).toISOString();
    expect(await restoreAt(justBefore)).toMatchObject({
      outcome: { status: "restored" },
      peers: ["a.example.org"],
    });
    expect(await restoreAt(stored.targetsExpires)).toEqual({
      outcome: { status: "expired", file, expires: stored.targetsExpires },
      peers: [],
    });

    const { targetsExpires: _dropped, ...undated } = stored;
    writeFileSync(file, JSON.stringify(undated));
    expect(await restoreAt(NOW)).toEqual({
      outcome: { status: "expired", file, expires: null },
      peers: [],
    });

    writeFileSync(file, JSON.stringify(stored));
    const other = await registryOf(["b.example.org"]);
    expect(await restoreAt(NOW, { ...gone, root: other.settings.root })).toEqual({
      outcome: { status: "other-root", file },
      peers: [],
    });
    expect(await restoreAt(NOW)).toMatchObject({ outcome: { status: "restored" } });
  });

  it("drops the registry's peers in a running process once their targets metadata expired", async () => {
    const { settings } = await registryOf(["a.example.org", SELF]);
    const book = new PeerBook([]);
    const discovery = new RegistryDiscovery(book, settings, SELF, noFetch);
    await discovery.sync(NOW);
    const { targetsExpires } = JSON.parse(
      readFileSync(join(settings.cacheDir, VERIFIED_PEERS_FILE), "utf8"),
    ) as StoredFile;
    const before = new Date(Date.parse(targetsExpires) - 1000).toISOString();
    // Within the expiry a failed sync leaves them.
    expect(discovery.expire(before)).toBeUndefined();
    expect(book.all().map((peer) => peer.instanceId)).toEqual(["a.example.org"]);
    // At it they go, once.
    expect(discovery.expire(targetsExpires)).toEqual({ peers: 1, expires: targetsExpires });
    expect(book.all()).toEqual([]);
    expect(discovery.expire(targetsExpires)).toBeUndefined();
    // A sync that verifies again brings them back.
    expect(await discovery.sync(NOW)).toMatchObject({ added: ["a.example.org"] });
    expect(book.all().map((peer) => peer.instanceId)).toEqual(["a.example.org"]);
  });

  it("reports when the registry's trusted root expires", async () => {
    const { settings } = await registryOf(["a.example.org"]);
    const synced = await new RegistryDiscovery(new PeerBook([]), settings, SELF, noFetch).sync(NOW);
    const root = JSON.parse(settings.root) as { signed: { expires: string } };
    expect(synced.rootExpires).toBe(new Date(root.signed.expires).toISOString());
  });

  it("starts without registry peers when nothing is stored, or what is stored does not parse", async () => {
    const { settings } = await registryOf(["a.example.org"]);
    const book = new PeerBook([]);
    const gone = unreachable(settings);
    const discovery = new RegistryDiscovery(book, gone, SELF, noFetch);
    await expect(discovery.sync(NOW)).rejects.toThrow();
    expect(await discovery.restore(NOW)).toMatchObject({ status: "absent" });
    expect(book.all()).toEqual([]);

    writeFileSync(join(settings.cacheDir, VERIFIED_PEERS_FILE), '{"syncedAt": "x", "peers": [');
    const again = new RegistryDiscovery(book, gone, SELF, noFetch);
    expect(await again.restore(NOW)).toMatchObject({ status: "unreadable" });
    writeFileSync(
      join(settings.cacheDir, VERIFIED_PEERS_FILE),
      JSON.stringify({ syncedAt: NOW, peers: [{ instanceId: "a.example.org" }] }),
    );
    const third = new RegistryDiscovery(book, gone, SELF, noFetch);
    expect(await third.restore(NOW)).toMatchObject({ status: "unreadable" });
    expect(book.all()).toEqual([]);
  });

  it("does not read the stored peers once a sync succeeded, and a later sync replaces them", async () => {
    const first = await registryOf(["a.example.org"]);
    const book = new PeerBook([]);
    const discovery = new RegistryDiscovery(book, first.settings, SELF, noFetch);
    await discovery.sync(NOW);
    expect(await discovery.restore(NOW)).toEqual({ status: "not-needed" });

    await sign(first.repoDir, first.roles, ["b.example.org"], 2);
    const later = new RegistryDiscovery(book, first.settings, SELF, noFetch);
    expect(await later.sync(NOW)).toMatchObject({ added: ["b.example.org"], removed: [] });
    const settings = first.settings;
    const stored = JSON.parse(
      readFileSync(join(settings.cacheDir, VERIFIED_PEERS_FILE), "utf8"),
    ) as { peers: { instanceId: string }[] };
    expect(stored.peers.map((peer) => peer.instanceId)).toEqual(["b.example.org"]);
  });
});
