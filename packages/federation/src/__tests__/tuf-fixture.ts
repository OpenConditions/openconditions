import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { multibaseFromRawEd25519 } from "../multibase.js";
import { registryEntryFileName } from "../registry.js";
import { signRegistry, type SignedRegistry, type TufRoleConfig } from "../tuf/repo.js";
import { generateTufSigner, type TufSigner } from "../tuf/signing.js";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function randomMultibase(): string {
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
  return multibaseFromRawEd25519(raw);
}

export function sampleEntry(id: string, overrides: Record<string, unknown> = {}): object {
  return {
    id,
    actor: `https://${id}.example.org/.well-known/openconditions/actor.json`,
    operator: {
      name: `Operator of ${id}`,
      contact: `federation@${id}.example.org`,
      jurisdiction: "DE",
    },
    coverage: { iso3166: ["DE"], bbox: [5.8, 47.2, 15.1, 55.1] },
    trustTier: 1,
    keys: [randomMultibase()],
    ...overrides,
  };
}

export function writeRegistryDir(entries: object[]): string {
  const dir = tempDir("oc-registry-");
  for (const entry of entries) {
    const id = (entry as { id: string }).id;
    writeFileSync(join(dir, registryEntryFileName(id)), stringify(entry));
  }
  return dir;
}

export interface RepoKeys {
  root: TufSigner[];
  targets: TufSigner[];
  snapshot: TufSigner[];
  timestamp: TufSigner[];
}

export async function makeRepoKeys(rootCount = 1): Promise<RepoKeys> {
  const root: TufSigner[] = [];
  for (let i = 0; i < rootCount; i++) root.push(await generateTufSigner());
  return {
    root,
    targets: [await generateTufSigner()],
    snapshot: [await generateTufSigner()],
    timestamp: [await generateTufSigner()],
  };
}

export type RoleName = "root" | "targets" | "snapshot" | "timestamp";

export function rolesFrom(
  keys: RepoKeys,
  overrides: Partial<Record<RoleName, Partial<TufRoleConfig>>> = {}
): Record<RoleName, TufRoleConfig> {
  const role = (signers: TufSigner[], name: RoleName): TufRoleConfig => ({
    keys: signers.map((signer) => signer.key),
    threshold: 1,
    signers,
    ...overrides[name],
  });
  return {
    root: role(keys.root, "root"),
    targets: role(keys.targets, "targets"),
    snapshot: role(keys.snapshot, "snapshot"),
    timestamp: role(keys.timestamp, "timestamp"),
  };
}

export interface BuildRepoOptions {
  registryDir: string;
  repoDir?: string;
  keys?: RepoKeys;
  roles?: Record<RoleName, TufRoleConfig>;
  version?: number;
  rootVersion?: number;
  expires?: Partial<Record<RoleName, string>>;
  now?: string;
}

export interface BuiltRepo extends SignedRegistry {
  repoDir: string;
  keys: RepoKeys;
  roles: Record<RoleName, TufRoleConfig>;
}

export async function buildRepo(options: BuildRepoOptions): Promise<BuiltRepo> {
  const keys = options.keys ?? (await makeRepoKeys());
  const roles = options.roles ?? rolesFrom(keys);
  const repoDir = options.repoDir ?? tempDir("oc-tuf-repo-");
  const signed = await signRegistry({
    registryDir: options.registryDir,
    repoDir,
    roles,
    version: options.version,
    rootVersion: options.rootVersion,
    expires: options.expires,
    now: options.now,
    testRoot: true,
  });
  return { ...signed, repoDir, keys, roles };
}

export function pastDate(daysAgo = 1): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}
