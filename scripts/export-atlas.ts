import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CatalogFeed,
  type CatalogFile,
  type CatalogResolver,
  type ChildFeed,
  credentialRefs,
  type FeedDefinition,
  type FetchFn,
  formatCatalogIssue,
  guardedFetch,
  type IngestDomain,
  lintCatalog,
  materializeCatalogChildren,
  readCatalogDir,
  type SharedCredentials,
  toCatalogFeed,
} from "@openconditions/ingest-framework";
import { INGEST_DOMAINS } from "../services/ingest/src/domains.js";
import { FEEDS_DIR, REPO_ROOT } from "./lib/catalog-paths.js";

/**
 * The feed atlas: `atlas/<domain>.json`, the public commons snapshot of one
 * domain's catalogue. It is both
 *
 * - a remote bundle (`files`) an instance can pull with
 *   `OPENCONDITIONS_FEEDS_REMOTE_URL`: the domain's region files as written,
 *   `$schema` included, and the shared credential groups they use; and
 * - the resolved index (`feeds`): every feed as the loader hands it out, with
 *   each catalogue parent followed by all of its children (approved or
 *   discovered), named by their child ids.
 *
 * Exporting resolves each catalogue live and refreshes the vendored snapshot
 * it falls back to, so the atlas and the snapshots move together. `--offline`
 * uses the vendored snapshots and touches no network.
 */

export interface Atlas {
  files: Record<string, unknown>;
  /** Each feed's `file` is its region file relative to the repository. */
  feeds: CatalogFeed[];
}

/** The shared groups the feeds of `files` refer to. */
function usedGroups(files: readonly CatalogFile[], shared: SharedCredentials): SharedCredentials {
  const used = new Set<string>();
  for (const file of files) {
    for (const feed of file.feeds) {
      for (const { ref } of credentialRefs(feed)) {
        if (ref.startsWith("@")) used.add(ref.slice(1).split(".")[0] as string);
      }
    }
  }
  return {
    groups: Object.fromEntries(Object.entries(shared.groups).filter(([g]) => used.has(g))),
  };
}

/**
 * The atlas of one domain from its catalogue files and the children each of
 * its resolvers found (by resolver id; a resolver without an entry uses its
 * vendored snapshot). `root` is the directory feed files are named relative to.
 */
export function buildAtlas(
  domain: IngestDomain,
  catalog: { files: readonly CatalogFile[]; credentials: SharedCredentials },
  children: ReadonlyMap<string, readonly ChildFeed[]>,
  root: string,
): Atlas {
  const files = catalog.files.filter((file) => file.domain === domain.id);
  const resolvers: CatalogResolver[] = domain.resolvers.map((resolver) => ({
    ...resolver,
    snapshot: children.get(resolver.id) ?? resolver.snapshot,
  }));
  const withChildren: IngestDomain = { ...domain, resolvers };

  const bundle: Record<string, unknown> = {};
  const feeds: CatalogFeed[] = [];
  for (const file of files) {
    bundle[`${domain.id}/${file.region}`] = {
      $schema: file.$schema,
      ...(file.maintainers.length > 0 ? { maintainers: file.maintainers } : {}),
      feeds: file.feeds,
    };
    const origin = {
      domain: file.domain,
      region: file.region,
      file: path.relative(root, file.path).split(path.sep).join("/"),
      maintainers: file.maintainers,
    };
    for (const definition of file.feeds) {
      const feed = toCatalogFeed(definition, origin);
      feeds.push(feed);
      if (!feed.catalog) continue;
      // An empty approval list sets every child apart as discovered, which
      // resolves each one without scheduling any.
      const all = { ...feed, catalog: { ...feed.catalog, approvedChildren: [] } };
      const { discovered, issues } = materializeCatalogChildren([all], [withChildren]);
      for (const issue of issues) console.warn(`[atlas] ${formatCatalogIssue(issue)}`);
      feeds.push(...discovered);
    }
  }

  const credentials = usedGroups(files, catalog.credentials);
  if (Object.keys(credentials.groups).length > 0) {
    bundle["credentials"] = { credentials: credentials.groups };
  }
  return { files: bundle, feeds };
}

/**
 * Where a domain's resolver snapshots are vendored in source. A resolver's own
 * `snapshotPath` names the directory of the module it is loaded from, which is
 * the built `dist` when a script imports the package.
 */
function snapshotFile(domain: IngestDomain, resolver: CatalogResolver): string {
  return path.join(
    REPO_ROOT,
    "packages",
    domain.id,
    "src/catalog/snapshots",
    path.basename(resolver.snapshotPath),
  );
}

/**
 * The catalogue parent a resolver resolves for, whose main endpoint names its
 * registry: the first feed of `files` that names the resolver. A resolver has
 * one snapshot, so a second parent of it shares the first one's children.
 */
export function resolverParent(
  files: readonly CatalogFile[],
  resolverId: string,
): FeedDefinition | undefined {
  return files.flatMap((file) => file.feeds).find((feed) => feed.catalog?.resolver === resolverId);
}

/** A resolver's children, live; undefined (with a warning) when the registry cannot be read. */
async function resolveLive(
  resolver: CatalogResolver,
  parent: FeedDefinition,
  fetchFn: FetchFn,
): Promise<ChildFeed[] | undefined> {
  try {
    return await resolver.resolve(parent, fetchFn);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.warn(`[atlas] ${resolver.id}: live resolve failed (${why}); using vendored snapshot`);
    return undefined;
  }
}

async function main(): Promise<void> {
  const offline = process.argv.includes("--offline");
  const catalog = readCatalogDir(FEEDS_DIR, INGEST_DOMAINS);
  const errors = lintCatalog(catalog.files, catalog.credentials, INGEST_DOMAINS).filter(
    (issue) => issue.level === "error",
  );
  if (errors.length > 0) {
    throw new Error(`feed catalogue has errors:\n  ${errors.map(formatCatalogIssue).join("\n  ")}`);
  }
  const fetchFn = guardedFetch();

  // Every atlas is built before any file is written, so a failure replaces nothing.
  const outputs: { file: string; content: unknown; label: string }[] = [];
  for (const domain of INGEST_DOMAINS) {
    const children = new Map<string, readonly ChildFeed[]>();
    for (const resolver of domain.resolvers) {
      // A resolver no feed names has no registry to read; its snapshot stands.
      const parent = resolverParent(catalog.files, resolver.id);
      const live = offline || !parent ? undefined : await resolveLive(resolver, parent, fetchFn);
      if (!live) continue;
      children.set(resolver.id, live);
      outputs.push({
        file: snapshotFile(domain, resolver),
        content: live,
        label: `${live.length} ${resolver.id} children`,
      });
    }
    const atlas = buildAtlas(domain, catalog, children, REPO_ROOT);
    outputs.push({
      file: path.join(REPO_ROOT, "atlas", `${domain.id}.json`),
      content: atlas,
      label: `${atlas.feeds.length} ${domain.id} feeds`,
    });
  }

  for (const { file, content, label } of outputs) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(content, null, 2)}\n`);
    console.info(`[atlas] wrote ${label} → ${path.relative(REPO_ROOT, file)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
