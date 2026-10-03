import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { z } from "zod";
import { assertPublicUrl, guardedFetch } from "../egress.js";
import { credentialRefs } from "./credentials.js";
import type { IngestDomain } from "./domain.js";
import { type Region, regionOfFile } from "./ids.js";
import {
  CREDENTIALS_FILE,
  duplicateIdIssues,
  feedIdIn,
  formatCatalogIssue,
  lintCatalog,
} from "./lint.js";
import { toCatalogFeed } from "./resolve.js";
import { materializeCatalogChildren } from "./resolvers.js";
import { type credentialFieldSchema, credentialsFileSchema, regionFileSchema } from "./schema.js";
import type { CatalogFeed, FeedDefinition, FetchFn, Maintainer } from "./types.js";

export type CredentialField = z.input<typeof credentialFieldSchema>;

/** One `feeds/<domain>/<region>.jsonc` file as read. */
export interface CatalogFile {
  path: string;
  domain: string;
  region: Region;
  maintainers: Maintainer[];
  /** The file's `$schema`, which the lint holds to the domain's generated schema. */
  $schema?: string;
  feeds: FeedDefinition[];
}

/** `feeds/credentials.jsonc`: credential fields shared by several feeds, by group. */
export interface SharedCredentials {
  groups: Readonly<Record<string, Readonly<Record<string, CredentialField>>>>;
}

export interface CatalogLayers {
  /** The catalogue shipped with the release. */
  baked: string;
  /** An operator's directory; absent or missing is no layer. */
  mount?: string;
  /** A bundle of region files fetched at startup, with the last good one kept at `snapshotPath`. */
  remote?: { url: string; snapshotPath: string };
}

export interface Catalog {
  /** What the scheduler polls: enabled feeds, catalogue parents replaced by their approved children. */
  feeds: readonly CatalogFeed[];
  /** Catalogue children not approved: shown to operators, never polled. */
  discovered: readonly CatalogFeed[];
  /** Feeds kept in the catalogue with a reason, never polled. */
  disabled: readonly CatalogFeed[];
  credentials: SharedCredentials;
}

interface Layer {
  files: CatalogFile[];
  credentials: SharedCredentials;
}

/** Generated JSON Schemas sit beside the domain directories. */
const SCHEMA_DIR = "schema";

// Caps for the remote bundle: declarative JSON, a few MB is generous.
const REMOTE_MAX_BYTES = 5_000_000;
const REMOTE_TIMEOUT_MS = 15_000;
const REMOTE_MAX_REDIRECTS = 3;

/** `file:line:column` of an offset, both 1-based. */
function position(file: string, text: string, offset: number): string {
  const before = text.slice(0, offset).split("\n");
  return `${file}:${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
}

/** A JSONC text as a value; syntax errors are pushed as `file:line:column: message`. */
function parseText(file: string, text: string, errors: string[]): unknown {
  const parseErrors: ParseError[] = [];
  const value: unknown = parseJsonc(text, parseErrors, { allowTrailingComma: true });
  for (const e of parseErrors) {
    errors.push(`${position(file, text, e.offset)}: ${printParseErrorCode(e.error)}`);
  }
  return parseErrors.length > 0 ? undefined : value;
}

/** A zod issue path as `feeds[3].endpoints.main.url`. */
function issuePath(segments: readonly PropertyKey[]): string {
  return segments
    .map((s, i) => (typeof s === "number" ? `[${s}]` : `${i === 0 ? "" : "."}${String(s)}`))
    .join("");
}

function schemaErrors(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${file} ${issuePath(i.path) || "(root)"}: ${i.message}`);
}

function regionFile(
  file: string,
  domain: IngestDomain,
  region: Region,
  value: unknown,
  errors: string[],
): CatalogFile | undefined {
  const res = regionFileSchema(domain.feedShape).safeParse(value);
  if (!res.success) {
    errors.push(...schemaErrors(file, res.error));
    return undefined;
  }
  const data = res.data as {
    $schema?: string;
    maintainers?: Maintainer[];
    feeds: FeedDefinition[];
  };
  const out: CatalogFile = {
    path: file,
    domain: domain.id,
    region,
    maintainers: data.maintainers ?? [],
    feeds: data.feeds,
  };
  if (data.$schema !== undefined) out.$schema = data.$schema;
  return out;
}

function sharedCredentials(file: string, value: unknown, errors: string[]): SharedCredentials {
  const res = credentialsFileSchema.safeParse(value);
  if (res.success) return { groups: res.data.credentials };
  errors.push(...schemaErrors(file, res.error));
  return { groups: {} };
}

function regionOf(file: string, errors: string[]): Region | undefined {
  try {
    return regionOfFile(file);
  } catch (err) {
    errors.push((err as Error).message);
    return undefined;
  }
}

function throwIfAny(errors: string[], what: string): void {
  if (errors.length > 0) throw new Error(`${what}:\n  ${errors.join("\n  ")}`);
}

/**
 * Reads a catalogue directory: `<dir>/<domain>/<region>.jsonc` for each known
 * domain and `<dir>/credentials.jsonc`. A directory that names no domain is an
 * error (except the generated `schema/`), and so are a file in a domain
 * directory that is not `.jsonc` (hidden files are skipped) and an id written twice. Every
 * problem is collected and thrown at once, naming `file:line:column` for a
 * syntax error and `file feeds[i].path` for a schema error.
 */
export function readCatalogDir(
  dir: string,
  domains: readonly IngestDomain[],
): { files: CatalogFile[]; credentials: SharedCredentials } {
  const errors: string[] = [];
  const files: CatalogFile[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === SCHEMA_DIR) continue;
    if (!domains.some((d) => d.id === entry.name)) {
      errors.push(`${path.join(dir, entry.name)}: unknown domain directory ${entry.name}`);
    }
  }

  for (const domain of domains) {
    const domainDir = path.join(dir, domain.id);
    if (!existsSync(domainDir)) continue;
    const names = readdirSync(domainDir).sort();
    for (const name of names) {
      // A hidden file (Finder's `.DS_Store`, an editor's swap file) is no one's region file.
      if (name.startsWith(".")) continue;
      const file = path.join(domainDir, name);
      // Anything else would silently not load: a renamed or misnamed file is an error.
      if (!name.endsWith(".jsonc")) {
        errors.push(`${file}: not a region file (<region>.jsonc)`);
        continue;
      }
      const region = regionOf(file, errors);
      const value = parseText(file, readFileSync(file, "utf8"), errors);
      if (region === undefined || value === undefined) continue;
      const parsed = regionFile(file, domain, region, value, errors);
      if (parsed) files.push(parsed);
    }
  }

  let credentials: SharedCredentials = { groups: {} };
  const credentialsPath = path.join(dir, CREDENTIALS_FILE);
  if (existsSync(credentialsPath)) {
    const value = parseText(credentialsPath, readFileSync(credentialsPath, "utf8"), errors);
    if (value !== undefined) credentials = sharedCredentials(credentialsPath, value, errors);
  }

  errors.push(...duplicateIdIssues(files).map(formatCatalogIssue));
  throwIfAny(errors, `invalid feed catalogue ${dir}`);
  return { files, credentials };
}

/**
 * A remote bundle, `{ "files": { "<domain>/<region>": <region file>,
 * "credentials": <credentials file> } }`, parsed as strictly as a directory.
 */
function parseBundle(label: string, text: string, domains: readonly IngestDomain[]): Layer {
  const errors: string[] = [];
  const raw: unknown = JSON.parse(text);
  const entries = raw && typeof raw === "object" ? (raw as { files?: unknown }).files : undefined;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new Error(`${label}: a bundle is { "files": { … } }`);
  }

  const files: CatalogFile[] = [];
  let credentials: SharedCredentials = { groups: {} };
  for (const [key, value] of Object.entries(entries)) {
    const file = `${label}#${key}`;
    if (key === "credentials") {
      credentials = sharedCredentials(file, value, errors);
      continue;
    }
    const [domainId, regionName, ...rest] = key.split("/");
    const domain = domains.find((d) => d.id === domainId);
    if (!domain || regionName === undefined || rest.length > 0) {
      errors.push(`${file}: not a "<domain>/<region>" of a known domain`);
      continue;
    }
    const region = regionOf(`${file}.jsonc`, errors);
    if (region === undefined) continue;
    const parsed = regionFile(file, domain, region, value, errors);
    if (parsed) files.push(parsed);
  }

  errors.push(...duplicateIdIssues(files).map(formatCatalogIssue));
  throwIfAny(errors, `invalid remote feed bundle ${label}`);
  return { files, credentials };
}

/** The lint errors of the catalogue the layers merge into, as lines. */
function lintErrors(
  layers: readonly Layer[],
  domains: readonly IngestDomain[],
  now: Date,
): string[] {
  const { files, credentials } = mergeLayers(layers);
  return lintCatalog(files, credentials, domains, now)
    .filter((issue) => issue.level === "error")
    .map(formatCatalogIssue);
}

/** The host of a request URL; an unparseable one (a templated host) stands as written. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Every host a feed sends requests to: its endpoints' URLs and its OAuth token URL. */
function requestHosts(feed: FeedDefinition): Set<string> {
  const urls = Object.values(feed.endpoints).flatMap((e) => [
    ...(e.url !== undefined ? [e.url] : []),
    ...(e.urls ?? []),
  ]);
  if (feed.auth?.kind === "oauth2-client-credentials") urls.push(feed.auth.tokenUrl);
  return new Set(urls.map(hostOf));
}

/**
 * Where a remote layer could route the operator's credentials to a host of its
 * choosing: a feed that reads a shared credential group (whose values the
 * operator set for other feeds) that no baked or mounted feed of its id
 * already reads, or an override of a baked or mounted feed that reads
 * credentials, sending them to a host that feed does not use. So a remote
 * layer may update a credentialed feed in place, never take its credentials
 * anywhere new.
 */
function remoteCredentialErrors(remote: Layer, local: readonly Layer[]): string[] {
  const localFeeds = new Map<string, FeedDefinition>();
  for (const layer of local) {
    for (const file of layer.files) {
      for (const feed of file.feeds) localFeeds.set(feedIdIn(file, feed), feed);
    }
  }
  const errors: string[] = [];
  for (const file of remote.files) {
    for (const feed of file.feeds) {
      const id = feedIdIn(file, feed);
      const local = localFeeds.get(id);
      const localRefs = new Set(local ? credentialRefs(local).map(({ ref }) => ref) : []);
      for (const { ref } of credentialRefs(feed)) {
        if (ref.startsWith("@") && !localRefs.has(ref)) {
          errors.push(`${file.path} ${id}: a remote feed may not read shared credential ${ref}`);
        }
      }
      if (!local || localRefs.size === 0) continue;
      const hosts = requestHosts(local);
      const foreign = [...requestHosts(feed)].filter((host) => !hosts.has(host));
      if (foreign.length > 0) {
        errors.push(
          `${file.path} ${id}: a remote override of a feed with credentials may not send them to ${foreign.join(", ")}`,
        );
      }
    }
  }
  return errors;
}

/**
 * Whether a remote layer may join the catalogue. The remote is untrusted, and a
 * bad one must fall back rather than stop the service, so it is judged where it
 * lands: merged with the baked and mounted layers. Throws when it could route
 * credentials (see {@link remoteCredentialErrors}), or when that catalogue has
 * errors the one without the remote does not (an unknown licence, a private
 * URL, a shared group it replaces or leaves with one user); errors the baked
 * and mounted layers have on their own are theirs, and `loadCatalog` reports them.
 */
function admitRemote(remote: Layer, ctx: RemoteContext, label: string): Layer {
  const { baked, mounted, domains, now } = ctx;
  const without = new Set(lintErrors([baked, ...mounted], domains, now));
  const merged = lintErrors([baked, remote, ...mounted], domains, now);
  throwIfAny(
    [
      ...remoteCredentialErrors(remote, [baked, ...mounted]),
      ...merged.filter((error) => !without.has(error)),
    ],
    `remote feed bundle ${label} breaks the catalogue`,
  );
  return remote;
}

interface RemoteContext {
  domains: readonly IngestDomain[];
  baked: Layer;
  /** The mounted layer, when there is one. */
  mounted: readonly Layer[];
  now: Date;
}

async function readSnapshot(snapshotPath: string, ctx: RemoteContext): Promise<Layer | undefined> {
  if (!existsSync(snapshotPath)) return undefined;
  try {
    const text = await readFile(snapshotPath, "utf8");
    return admitRemote(parseBundle(snapshotPath, text, ctx.domains), ctx, snapshotPath);
  } catch (err) {
    console.warn(`[catalog] remote snapshot unusable (${(err as Error).message})`);
    return undefined;
  }
}

/**
 * The remote layer: fetched through the egress guard, admitted (see
 * {@link admitRemote}) and only then written to the snapshot. On any failure
 * the last good snapshot is used, admitted the same way; without a usable one
 * there is no remote layer.
 */
async function remoteLayer(
  remote: NonNullable<CatalogLayers["remote"]>,
  ctx: RemoteContext,
  remoteFetch: FetchFn | undefined,
): Promise<Layer | undefined> {
  const fetchFn =
    remoteFetch ??
    guardedFetch(undefined, {
      maxBytes: REMOTE_MAX_BYTES,
      timeoutMs: REMOTE_TIMEOUT_MS,
      maxRedirects: REMOTE_MAX_REDIRECTS,
    });
  try {
    assertPublicUrl(remote.url);
    const res = await fetchFn(remote.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const layer = admitRemote(parseBundle(remote.url, text, ctx.domains), ctx, remote.url);
    try {
      await mkdir(path.dirname(remote.snapshotPath), { recursive: true });
      await writeFile(remote.snapshotPath, text, "utf8");
    } catch (err) {
      console.warn(`[catalog] could not write remote snapshot: ${(err as Error).message}`);
    }
    return layer;
  } catch (err) {
    console.warn(`[catalog] remote catalogue failed (${(err as Error).message}); using snapshot`);
    const snapshot = await readSnapshot(remote.snapshotPath, ctx);
    if (!snapshot) console.warn("[catalog] no usable remote snapshot; remote layer skipped");
    return snapshot;
  }
}

/**
 * Layers merged by feed id, later layers winning: each file keeps only the
 * feeds no later layer overrides. Shared groups merge whole, by name.
 */
function mergeLayers(layers: readonly Layer[]): Layer {
  const winner = new Map<string, CatalogFile>();
  for (const layer of layers) {
    for (const file of layer.files) {
      for (const feed of file.feeds) {
        winner.set(feedIdIn(file, feed), file);
      }
    }
  }
  return {
    files: layers.flatMap((layer) =>
      layer.files.map((file) => ({
        ...file,
        feeds: file.feeds.filter((feed) => winner.get(feedIdIn(file, feed)) === file),
      })),
    ),
    credentials: {
      groups: Object.assign({}, ...layers.map((layer) => layer.credentials.groups)),
    },
  };
}

function resolved(file: CatalogFile, feed: FeedDefinition): CatalogFeed {
  return toCatalogFeed(feed, {
    domain: file.domain,
    region: file.region,
    file: file.path,
    maintainers: file.maintainers,
  });
}

/**
 * The catalogue the service runs: the baked, remote and mounted layers merged
 * by id (mount > remote > baked), linted as a whole (any `error` throws, each
 * `warning` is logged), each feed resolved, disabled feeds set apart and
 * catalogue parents replaced by their approved children.
 */
export async function loadCatalog(
  domains: readonly IngestDomain[],
  layers: CatalogLayers,
  deps: { remoteFetch?: FetchFn; now?: () => Date } = {},
): Promise<Catalog> {
  const now = deps.now?.() ?? new Date();
  const baked = readCatalogDir(layers.baked, domains);
  const mounted =
    layers.mount && existsSync(layers.mount) ? [readCatalogDir(layers.mount, domains)] : [];
  const remote = layers.remote
    ? await remoteLayer(layers.remote, { domains, baked, mounted, now }, deps.remoteFetch)
    : undefined;
  const { files, credentials } = mergeLayers([baked, ...(remote ? [remote] : []), ...mounted]);

  const issues = lintCatalog(files, credentials, domains, now);
  const errors = issues.filter((i) => i.level === "error");
  throwIfAny(errors.map(formatCatalogIssue), "feed catalogue has errors");
  for (const warning of issues.filter((i) => i.level === "warning")) {
    console.warn(`[catalog] ${formatCatalogIssue(warning)}`);
  }

  const feeds = files.flatMap((file) => file.feeds.map((feed) => resolved(file, feed)));
  // Its issues are the lint's, already thrown or logged above.
  const { scheduled, discovered } = materializeCatalogChildren(
    feeds.filter((feed) => !feed.disabled),
    domains,
  );
  return {
    feeds: scheduled,
    discovered,
    disabled: feeds.filter((feed) => feed.disabled),
    credentials,
  };
}
