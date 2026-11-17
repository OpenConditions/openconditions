/**
 * Peer discovery through the federation registry: its TUF metadata is pulled
 * and verified (rollback, freeze, expiry and signature thresholds), and the
 * instances it lists join the configured peers (`PeerBook.discover`), the
 * operator's own record of a peer winning. A sync that fails verification
 * changes nothing: the peers of the last verified sync stay. The registry is
 * fetched through the egress guard the caller passes, without the client
 * certificate peers are shown: it is not a peer.
 *
 * Each verified sync's peers are also written to a file beside the TUF cache,
 * so they stay across a restart: when the first sync after boot fails, they
 * are read back from there, as trusted as the verified metadata they came
 * from, and no longer. The file states when that sync's verified `targets`
 * metadata expires and a SHA-256 of the trusted root it was verified under:
 * past that expiry, or under another configured root, the stored peers are
 * not taken back, so a registry blocked or frozen cannot keep its last list
 * trusted beyond what TUF would allow, and a replaced root drops what the old
 * one vouched for. Once a sync succeeded in this process the file is only
 * written, never read.
 *
 * The same bound holds while the process runs: when syncs keep failing past
 * the expiry of the targets metadata the known peers came from, those peers
 * are dropped ({@link RegistryDiscovery.expire}), so whether a blocked or
 * frozen registry's last list is still trusted does not depend on whether
 * the service happened to restart. Peers the operator configured are not the
 * registry's and stay.
 */
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPeers, type PeerRecord, syncRegistry } from "@openconditions/federation";
import type { RegistrySettings } from "./config.js";
import type { PeerBook } from "./peer-book.js";

/** How long a failed sync waits before it tries again. */
export const REGISTRY_RETRY_MS = 60 * 60 * 1000;

/** The file in the registry cache that keeps the peers of the last verified sync. */
export const VERIFIED_PEERS_FILE = "verified-peers.json";

/** What a verified sync changed, this instance's own entry left out. */
export interface RegistrySyncChanges {
  syncedAt: string;
  added: string[];
  removed: string[];
  changed: string[];
  /** Why the peers could not be stored for the next boot; absent when they were. */
  storeError?: string;
  /** When the registry's trusted root expires, when its metadata states it. */
  rootExpires?: string;
}

/** What reading back the stored peers came to. */
export type RegistryRestore =
  | { status: "restored"; peers: number; syncedAt: string; file: string }
  | { status: "absent"; file: string }
  | { status: "unreadable"; file: string; error: string }
  /** Past the expiry of the targets metadata they came from, or stored without one. */
  | { status: "expired"; file: string; expires: string | null }
  /** Stored under another trusted root than the one configured now. */
  | { status: "other-root"; file: string }
  | { status: "not-needed" };

interface StoredPeers {
  syncedAt: string;
  /** When the verified `targets` metadata of that sync expires. */
  targetsExpires: string;
  /** SHA-256 (hex) of the trusted root configured when the sync was verified. */
  rootSha256: string;
  peers: PeerRecord[];
}

/** What a stored file says, its bounds unchecked yet. */
interface ParsedPeers {
  syncedAt: string;
  targetsExpires: string | null;
  rootSha256: string | null;
  peers: PeerRecord[];
}

/** The registry discovery of one process: its syncs, and the stored peers of the last one. */
export class RegistryDiscovery {
  readonly #peers: PeerBook;
  readonly #registry: RegistrySettings;
  readonly #self: string;
  readonly #fetchImpl: typeof fetch;
  /** SHA-256 (hex) of the trusted root configured now. */
  readonly #rootSha256: string;
  /** The registry's peers as the last verified sync listed them, or as stored after one. */
  #last: PeerRecord[] = [];
  /** When the targets metadata `#last` came from expires; null while no peers are held. */
  #validUntil: string | null = null;
  #synced = false;
  #restoreTried = false;

  constructor(peers: PeerBook, registry: RegistrySettings, self: string, fetchImpl: typeof fetch) {
    this.#peers = peers;
    this.#registry = registry;
    this.#self = self;
    this.#fetchImpl = fetchImpl;
    this.#rootSha256 = createHash("sha256").update(registry.root).digest("hex");
  }

  get file(): string {
    return join(this.#registry.cacheDir, VERIFIED_PEERS_FILE);
  }

  /** Whether a sync succeeded in this process. */
  get synced(): boolean {
    return this.#synced;
  }

  /**
   * Syncs the registry and has the peer book take what it lists, then stores
   * those peers for the next boot. Throws when the sync fails verification
   * or cannot be fetched; the peers known before stay.
   */
  async sync(now: string): Promise<RegistrySyncChanges> {
    const result = await syncRegistry(
      { metadataUrl: this.#registry.metadataUrl, targetsUrl: this.#registry.targetsUrl },
      this.#registry.root,
      {
        cacheDir: this.#registry.cacheDir,
        previousPeers: this.#last,
        now,
        fetchImpl: this.#fetchImpl,
      },
    );
    const notSelf = (instanceId: string) => instanceId !== this.#self;
    const peers = result.peers.filter((peer) => notSelf(peer.instanceId));
    this.#peers.discover(peers, this.#self);
    this.#last = peers;
    this.#validUntil = result.targetsExpires;
    this.#synced = true;
    const changes: RegistrySyncChanges = {
      syncedAt: result.syncedAt,
      added: result.added.filter(notSelf),
      removed: result.removed.filter(notSelf),
      changed: result.changed.filter(notSelf),
      ...(result.rootExpires !== undefined ? { rootExpires: result.rootExpires } : {}),
    };
    try {
      await this.#store({
        syncedAt: result.syncedAt,
        targetsExpires: result.targetsExpires,
        rootSha256: this.#rootSha256,
        peers,
      });
    } catch (err) {
      changes.storeError = err instanceof Error ? err.message : String(err);
    }
    return changes;
  }

  /**
   * Reads back the peers the last verified sync stored and has the peer book
   * take them, once, and only while no sync has succeeded in this process,
   * `now` is before the expiry of the targets metadata they came from, and
   * the trusted root configured now is the one they were verified under.
   */
  async restore(now: string): Promise<RegistryRestore> {
    if (this.#synced || this.#restoreTried) return { status: "not-needed" };
    this.#restoreTried = true;
    const file = this.file;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent", file };
      return { status: "unreadable", file, error: (err as Error).message };
    }
    let stored: ParsedPeers;
    try {
      stored = parseStoredPeers(text);
    } catch (err) {
      return { status: "unreadable", file, error: (err as Error).message };
    }
    if (stored.targetsExpires === null || Date.parse(now) >= Date.parse(stored.targetsExpires)) {
      return { status: "expired", file, expires: stored.targetsExpires };
    }
    if (stored.rootSha256 !== this.#rootSha256) return { status: "other-root", file };
    const peers = stored.peers.filter((peer) => peer.instanceId !== this.#self);
    this.#peers.discover(peers, this.#self);
    this.#last = peers;
    this.#validUntil = stored.targetsExpires;
    return { status: "restored", peers: peers.length, syncedAt: stored.syncedAt, file };
  }

  /**
   * Drops the registry's peers once `now` is at or past the expiry of the
   * targets metadata they came from: called when a sync failed, so peers a
   * registry can no longer vouch for do not stay trusted for as long as it
   * cannot be reached. Returns how many were dropped and the expiry, or
   * undefined when they are still within it or none is held.
   */
  expire(now: string): { peers: number; expires: string } | undefined {
    if (this.#validUntil === null || Date.parse(now) < Date.parse(this.#validUntil)) {
      return undefined;
    }
    const dropped = { peers: this.#last.length, expires: this.#validUntil };
    this.#peers.discover([], this.#self);
    this.#last = [];
    this.#validUntil = null;
    return dropped.peers > 0 ? dropped : undefined;
  }

  /** Writes `stored` to a temporary file and renames it over the last, so a reader never sees half. */
  async #store(stored: StoredPeers): Promise<void> {
    const file = this.file;
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }
}

function parseStoredPeers(text: string): ParsedPeers {
  const value = JSON.parse(text) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("not an object");
  }
  const { syncedAt, targetsExpires, rootSha256, peers } = value as Record<string, unknown>;
  if (typeof syncedAt !== "string" || Number.isNaN(Date.parse(syncedAt))) {
    throw new TypeError("syncedAt is not a timestamp");
  }
  return {
    syncedAt,
    targetsExpires:
      typeof targetsExpires === "string" && !Number.isNaN(Date.parse(targetsExpires))
        ? targetsExpires
        : null,
    rootSha256: typeof rootSha256 === "string" ? rootSha256 : null,
    peers: loadPeers(peers),
  };
}
