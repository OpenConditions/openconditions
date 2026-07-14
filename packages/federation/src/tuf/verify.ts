/**
 * The registry verification client — the security anchor of federation
 * discovery. All TUF client-workflow checks (root rotation, signature
 * thresholds, version rollback, freeze/expiry, snapshot/targets consistency,
 * target hash verification) are performed by tuf-js' `Updater`; this module
 * never re-implements any of them. What it adds on top:
 *
 *  - the fail-closed TEST-root refusal: a root stamped with
 *    {@link TEST_ROOT_MARKER} (the only kind this repo's release tool can
 *    produce) is refused outright under a production NODE_ENV, before any
 *    metadata is fetched;
 *  - a local-directory fetcher so a registry checkout / CI fixture can be
 *    verified exactly like a remote registry;
 *  - parsing each verified target back into a {@link RegistryEntry}, with the
 *    target file name required to match the entry id.
 *
 * The client's `cacheDir` is its rollback memory: tuf-js persists verified
 * metadata there, so a later sync that serves older versions is rejected.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Metadata, MetadataKind } from "@tufjs/models";
import { BaseFetcher, Updater } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error.js";
import { parseRegistryEntry, registryEntryFileName, type RegistryEntry } from "../registry.js";

/**
 * Root metadata field marking a CI/test trust root. Any root produced by
 * this repository's `signRegistry` carries it; a production deployment must
 * never trust such a root, and {@link verifyRegistryMetadata} enforces that.
 */
export const TEST_ROOT_MARKER = "x-openconditions-test-root";

/**
 * Thrown when a TEST-marked trust root is used outside an explicit dev/test
 * context. The gate fails closed: only NODE_ENV in {development, test} or an
 * explicit `allowTestRoot` opt-in permits it, so an unset/unknown/production
 * environment refuses.
 */
export class TestRootInProductionError extends Error {
  constructor() {
    super(
      `refusing to trust a ${TEST_ROOT_MARKER}-marked TUF root: it is permitted only under an ` +
        "explicit dev/test NODE_ENV or the allowTestRoot opt-in; an unset, unknown, or production " +
        "environment fails closed. Production requires a root from the offline key ceremony " +
        "(docs/federation-onboarding.md)"
    );
    this.name = "TestRootInProductionError";
  }
}

/** Where a registry repository's metadata and target files are served from. */
export interface RegistryRepoSource {
  metadataUrl: string;
  targetsUrl: string;
}

/** Maps a local repository directory (metadata/ + targets/) to fetch URLs. */
export function repoSourceFromDir(repoDir: string): RegistryRepoSource {
  return {
    metadataUrl: pathToFileURL(join(repoDir, "metadata")).href,
    targetsUrl: pathToFileURL(join(repoDir, "targets")).href,
  };
}

/** NODE_ENV values that permit a TEST-marked trust root. */
export const TEST_ROOT_ALLOWED_ENVS = ["development", "test"] as const;

export interface VerifyRegistryOptions {
  /**
   * The client's persistent trusted-metadata store. MUST be retained between
   * syncs — it is what makes rollback protection stateful.
   */
  cacheDir: string;
  /** Environment gate for the test-root refusal; default `process.env.NODE_ENV`. */
  env?: string;
  /**
   * Explicit opt-in to accept a TEST-marked root regardless of environment
   * (e.g. an in-memory unit test with no NODE_ENV set). Absent this and an
   * explicit dev/test `env`, a test root is REFUSED — an unset or unknown
   * NODE_ENV fails closed.
   */
  allowTestRoot?: boolean;
}

/** Serves `file:` URLs for local registry checkouts and CI fixtures. */
class FileFetcher extends BaseFetcher {
  fetch(url: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    const path = fileURLToPath(url);
    if (!existsSync(path)) {
      return Promise.reject(new DownloadHTTPError(`file not found: ${path}`, 404));
    }
    return Promise.resolve(
      Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array<ArrayBuffer>>
    );
  }
}

function isTestRootAllowed(env: string | undefined, allowTestRoot: boolean | undefined): boolean {
  if (allowTestRoot === true) return true;
  return (TEST_ROOT_ALLOWED_ENVS as readonly string[]).includes(env ?? "");
}

/**
 * Fail-closed test-root gate: a TEST-marked root is refused UNLESS the
 * environment is EXPLICITLY dev/test or the caller opts in with
 * `allowTestRoot`. An unset, unknown, or production NODE_ENV all refuse — so
 * a deployment that forgets to set NODE_ENV cannot silently run on CI trust
 * material. This is an accidental-misuse guard, not a boundary against a
 * forged production root; the real security is the offline 2-of-3 ceremony.
 */
function assertRootAllowedInEnv(
  rootJson: unknown,
  env: string | undefined,
  allowTestRoot: boolean | undefined
): void {
  const metadata = Metadata.fromJSON(
    MetadataKind.Root,
    rootJson as Parameters<typeof Metadata.fromJSON>[1]
  );
  if (
    metadata.signed.unrecognizedFields[TEST_ROOT_MARKER] === true &&
    !isTestRootAllowed(env, allowTestRoot)
  ) {
    throw new TestRootInProductionError();
  }
}

function parseJsonBytes(bytes: Buffer | Uint8Array | string): unknown {
  const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
  return JSON.parse(text) as unknown;
}

/**
 * Verifies the registry's TUF metadata and returns the registry entries,
 * sorted by id. `source` is a local repository directory or an explicit
 * metadata/targets URL pair; `trustedRoot` is the out-of-band distributed
 * root.json (bytes or JSON text) that anchors trust on the FIRST sync — once
 * the cache holds a trusted root, the cached copy (including any rotations
 * accepted since) is authoritative.
 *
 * Everything the TUF spec requires a client to reject — rollback, freeze,
 * expired metadata, snapshot/targets mix-and-match, unauthorized keys,
 * below-threshold signature sets — surfaces here as a thrown error from the
 * tuf-js refresh; callers must treat any throw as "keep the previous peer
 * set", never as "proceed unpinned".
 */
export async function verifyRegistryMetadata(
  source: string | RegistryRepoSource,
  trustedRoot: Buffer | Uint8Array | string,
  options: VerifyRegistryOptions
): Promise<RegistryEntry[]> {
  const { metadataUrl, targetsUrl } =
    typeof source === "string" ? repoSourceFromDir(source) : source;
  const env = options.env ?? process.env.NODE_ENV;
  const allowTestRoot = options.allowTestRoot;

  assertRootAllowedInEnv(parseJsonBytes(trustedRoot), env, allowTestRoot);

  mkdirSync(options.cacheDir, { recursive: true });
  const downloadDir = join(options.cacheDir, "targets");
  mkdirSync(downloadDir, { recursive: true });

  const cachedRootPath = join(options.cacheDir, "root.json");
  if (!existsSync(cachedRootPath)) {
    writeFileSync(
      cachedRootPath,
      typeof trustedRoot === "string" ? trustedRoot : Buffer.from(trustedRoot)
    );
  }
  assertRootAllowedInEnv(parseJsonBytes(readFileSync(cachedRootPath)), env, allowTestRoot);

  const updater = new Updater({
    metadataDir: options.cacheDir,
    metadataBaseUrl: metadataUrl,
    targetDir: downloadDir,
    targetBaseUrl: targetsUrl,
    fetcher: metadataUrl.startsWith("file:") ? new FileFetcher() : undefined,
  });
  await updater.refresh();

  assertRootAllowedInEnv(parseJsonBytes(readFileSync(cachedRootPath)), env, allowTestRoot);

  const targetsMetadata = Metadata.fromJSON(
    MetadataKind.Targets,
    parseJsonBytes(readFileSync(join(options.cacheDir, "targets.json"))) as Parameters<
      typeof Metadata.fromJSON
    >[1]
  );
  const entries: RegistryEntry[] = [];
  for (const targetPath of Object.keys(targetsMetadata.signed.targets)) {
    if (!targetPath.endsWith(".yaml")) continue;
    const targetInfo = await updater.getTargetInfo(targetPath);
    if (!targetInfo) {
      throw new Error(`verified targets metadata lists ${targetPath} but it cannot be resolved`);
    }
    const cached = await updater.findCachedTarget(targetInfo);
    const filePath = cached ?? (await updater.downloadTarget(targetInfo));
    const entry = parseRegistryEntry(readFileSync(filePath, "utf8"));
    if (registryEntryFileName(entry.id) !== targetPath) {
      throw new TypeError(
        `registry target ${targetPath} declares mismatching id "${entry.id}"; refusing the entry`
      );
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}
