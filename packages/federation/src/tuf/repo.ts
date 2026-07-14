/**
 * The registry release procedure: sign a directory of registry YAML files
 * into a TUF metadata repository (root / targets / snapshot / timestamp)
 * using @tufjs/models — metadata layout, canonical-JSON signing input, and
 * key/threshold semantics all come from the library, never hand-rolled.
 *
 * THIS TOOL ONLY PRODUCES TEST ROOTS. Every root it writes carries the
 * {@link TEST_ROOT_MARKER} field and the verification client refuses such a
 * root under a production NODE_ENV. A production trust root requires an
 * OFFLINE key ceremony with the reviewed 2-of-3 governance threshold — an
 * operator/organizational action performed outside this repository (see
 * docs/federation-onboarding.md), not a code path here.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalize } from "@tufjs/canonical-json";
import {
  Key,
  MetaFile,
  Metadata,
  Root,
  Snapshot,
  TargetFile,
  Targets,
  Timestamp,
} from "@tufjs/models";
import { Role } from "@tufjs/models/dist/role.js";
import { parseRegistryEntry, registryEntryFileName } from "../registry.js";
import { TEST_ROOT_MARKER } from "./verify.js";
import type { TufSigner } from "./signing.js";

/** TUF specification version stamped into every metadata file. */
export const TUF_SPEC_VERSION = "1.0.31";

export type TufRoleName = "root" | "targets" | "snapshot" | "timestamp";

/** Default per-role metadata lifetimes, in days. */
export const DEFAULT_EXPIRY_DAYS: Record<TufRoleName, number> = {
  root: 365,
  targets: 90,
  snapshot: 7,
  timestamp: 1,
};

export interface TufRoleConfig {
  /** Public keys authorized for the role (recorded in root). */
  keys: Key[];
  /** How many of those keys a valid signature set requires. */
  threshold: number;
  /**
   * The keypairs that actually sign. For a root rotation this list carries
   * BOTH old and new keys so the new root satisfies the previous root's
   * threshold as well as its own. The release tool deliberately does not
   * enforce signers >= threshold — the client does, and must.
   */
  signers: TufSigner[];
}

export interface SignRegistryOptions {
  /** Directory of `<id>.yaml` registry entries to publish. */
  registryDir: string;
  /** Output repository directory (gets `metadata/` and `targets/`). */
  repoDir: string;
  roles: Record<TufRoleName, TufRoleConfig>;
  /** Version for targets/snapshot/timestamp metadata (a release). Default 1. */
  version?: number;
  /** Root metadata version; bump only on a key rotation. Default 1. */
  rootVersion?: number;
  /** Per-role expiry override (ISO 8601); defaults derive from `now`. */
  expires?: Partial<Record<TufRoleName, string>>;
  /** Base time for default expiries; defaults to the current time. */
  now?: string;
  /**
   * Must be literally `true`: this tool only generates CI/test trust roots,
   * stamped with {@link TEST_ROOT_MARKER}. Production roots come from the
   * offline key ceremony, never from here.
   */
  testRoot: true;
}

export interface SignedRegistry {
  metadataDir: string;
  targetsDir: string;
  /** Registry target file names, sorted. */
  targetFiles: string[];
  /** The signed root metadata — the client's initial trust anchor. */
  rootBytes: Buffer;
}

/** TUF-spec timestamp format (second precision, Z suffix). */
function tufDate(base: string, plusDays: number): string {
  const date = new Date(new Date(base).getTime() + plusDays * 24 * 60 * 60 * 1000);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function metadataBytes(metadata: Metadata<Root | Targets | Snapshot | Timestamp>): Buffer {
  return Buffer.from(canonicalize(metadata.toJSON()));
}

function hashesFor(bytes: Buffer): Record<string, string> {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("hex"),
  };
}

/**
 * Signs the registry directory into a TUF repository. Deterministic by
 * design: the same registry contents, keys, versions, and `now` produce
 * byte-identical metadata (canonical JSON output + deterministic Ed25519),
 * so a release can be reproduced and audited.
 */
export async function signRegistry(options: SignRegistryOptions): Promise<SignedRegistry> {
  if (options.testRoot !== true) {
    throw new Error(
      "signRegistry only produces marked TEST roots; a production trust root requires the offline key ceremony described in docs/federation-onboarding.md"
    );
  }
  const now = options.now ?? new Date().toISOString();
  const version = options.version ?? 1;
  const rootVersion = options.rootVersion ?? 1;
  const expiresFor = (role: TufRoleName): string =>
    options.expires?.[role] ?? tufDate(now, DEFAULT_EXPIRY_DAYS[role]);

  const metadataDir = join(options.repoDir, "metadata");
  const targetsDir = join(options.repoDir, "targets");
  mkdirSync(metadataDir, { recursive: true });
  mkdirSync(targetsDir, { recursive: true });

  const targetFiles = readdirSync(options.registryDir)
    .filter((file) => file.endsWith(".yaml"))
    .sort();
  const targets = new Targets({
    version,
    specVersion: TUF_SPEC_VERSION,
    expires: expiresFor("targets"),
  });
  for (const file of targetFiles) {
    const sourcePath = join(options.registryDir, file);
    const bytes = readFileSync(sourcePath);
    const entry = parseRegistryEntry(bytes.toString("utf8"));
    if (registryEntryFileName(entry.id) !== file) {
      throw new TypeError(
        `registry file ${file} does not match its entry id "${entry.id}" (expected ${registryEntryFileName(entry.id)})`
      );
    }
    if (resolve(options.registryDir) !== resolve(targetsDir)) {
      copyFileSync(sourcePath, join(targetsDir, file));
    }
    targets.addTarget(
      new TargetFile({ length: bytes.length, path: file, hashes: hashesFor(bytes) })
    );
  }

  const root = new Root({
    version: rootVersion,
    specVersion: TUF_SPEC_VERSION,
    expires: expiresFor("root"),
    consistentSnapshot: false,
    roles: {
      root: new Role({ keyIDs: [], threshold: options.roles.root.threshold }),
      targets: new Role({ keyIDs: [], threshold: options.roles.targets.threshold }),
      snapshot: new Role({ keyIDs: [], threshold: options.roles.snapshot.threshold }),
      timestamp: new Role({ keyIDs: [], threshold: options.roles.timestamp.threshold }),
    },
    unrecognizedFields: { [TEST_ROOT_MARKER]: true },
  });
  for (const roleName of ["root", "targets", "snapshot", "timestamp"] as const) {
    for (const key of options.roles[roleName].keys) root.addKey(key, roleName);
  }
  const rootMetadata = new Metadata(root);
  for (const signer of options.roles.root.signers) rootMetadata.sign(signer.sign);
  const rootBytes = metadataBytes(rootMetadata);

  const targetsMetadata = new Metadata(targets);
  for (const signer of options.roles.targets.signers) targetsMetadata.sign(signer.sign);
  const targetsBytes = metadataBytes(targetsMetadata);

  const snapshot = new Snapshot({
    version,
    specVersion: TUF_SPEC_VERSION,
    expires: expiresFor("snapshot"),
    meta: {
      "targets.json": new MetaFile({
        version,
        length: targetsBytes.length,
        hashes: hashesFor(targetsBytes),
      }),
    },
  });
  const snapshotMetadata = new Metadata(snapshot);
  for (const signer of options.roles.snapshot.signers) snapshotMetadata.sign(signer.sign);
  const snapshotBytes = metadataBytes(snapshotMetadata);

  const timestamp = new Timestamp({
    version,
    specVersion: TUF_SPEC_VERSION,
    expires: expiresFor("timestamp"),
    snapshotMeta: new MetaFile({
      version,
      length: snapshotBytes.length,
      hashes: hashesFor(snapshotBytes),
    }),
  });
  const timestampMetadata = new Metadata(timestamp);
  for (const signer of options.roles.timestamp.signers) timestampMetadata.sign(signer.sign);

  writeFileSync(join(metadataDir, `${rootVersion}.root.json`), rootBytes);
  writeFileSync(join(metadataDir, "targets.json"), targetsBytes);
  writeFileSync(join(metadataDir, "snapshot.json"), snapshotBytes);
  writeFileSync(join(metadataDir, "timestamp.json"), metadataBytes(timestampMetadata));

  return { metadataDir, targetsDir, targetFiles, rootBytes };
}
