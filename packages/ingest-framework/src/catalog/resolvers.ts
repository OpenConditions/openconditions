import { writeFile } from "node:fs/promises";
import { guardedFetch } from "../egress.js";
import type { IngestDomain } from "./domain.js";
import { deriveFeedId } from "./ids.js";
import type { CatalogIssue } from "./lint.js";
import { toCatalogFeed } from "./resolve.js";
import { admitsCatalogChild } from "./terms.js";
import type { CatalogFeed, FeedDefinition, FetchFn } from "./types.js";

/**
 * A feed a catalogue resolver found. It is named by its qualifier; region,
 * subdivision, operator and product are its parent's, and every field it
 * leaves out is inherited from the parent.
 */
export type ChildFeed = Partial<FeedDefinition> & {
  qualifier: string;
  name: string;
  endpoints: FeedDefinition["endpoints"];
  selectionState: "approved" | "discovered";
};

/**
 * Expands a catalogue (a registry of feeds) into concrete children. Fetches the
 * registry only through the injected `fetch` (so the egress guard applies) and
 * returns pure-data children, so the resolved set is serialisable into the
 * snapshot it falls back to.
 */
export interface CatalogResolver {
  id: string;
  /** Absolute path to the vendored snapshot the export script writes on success. */
  snapshotPath: string;
  /**
   * The vendored children, imported as a JSON module so they survive being
   * inlined into a service bundle (where `snapshotPath` would resolve to the
   * wrong dist dir). Used when a live resolve fails, and to materialise approved
   * children at startup.
   */
  snapshot: readonly ChildFeed[];
  /** The children of the registry `parent` names (see {@link registryUrl}). */
  resolve(parent: CatalogParent, fetchFn: FetchFn): Promise<ChildFeed[]>;
}

/** What a resolver reads of the catalogue parent it resolves for. */
export type CatalogParent = Pick<FeedDefinition, "endpoints">;

/**
 * The registry a catalogue parent names: the URL of its `main` endpoint, the
 * one place the catalogue writes it. Throws, naming the resolver, when there is
 * none, or when it is not an absolute http(s) URL written out in full (a
 * resolver fills no `${…}` placeholder).
 */
export function registryUrl(parent: CatalogParent, resolverId: string): string {
  const url = parent.endpoints["main"]?.url;
  if (url === undefined) {
    throw new Error(`${resolverId}: a catalogue parent names its registry in endpoints.main.url`);
  }
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (url.includes("${") || !parsed || !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${resolverId}: ${url} is not a usable registry URL`);
  }
  return url;
}

/** The resolver a catalogue parent names, from its own domain; throws when there is none. */
export function catalogResolverFor(
  feed: CatalogFeed,
  resolvers: readonly CatalogResolver[],
): CatalogResolver {
  const id = feed.catalog?.resolver;
  const resolver = resolvers.find((r) => r.id === id);
  if (!resolver) throw new Error(`no catalogue resolver "${id}" for feed ${feed.id}`);
  return resolver;
}

/**
 * A child as a complete feed: the parent's definition overlaid with the child's
 * fields, under the parent's region, subdivision, operator and product. A child
 * with its own licence is judged by its own terms alone; one without inherits
 * the parent's licence, and the parent's terms unless it states its own.
 */
function childFeed(parent: CatalogFeed, child: ChildFeed): CatalogFeed {
  const ownLicense = child.license !== undefined;
  const def: FeedDefinition = {
    ...parent,
    ...child,
    subdivision: parent.subdivision,
    operator: parent.operator,
    product: parent.product,
    catalog: undefined,
    license: child.license ?? parent.license,
    terms: ownLicense ? child.terms : (child.terms ?? parent.terms),
  };
  const feed = toCatalogFeed(def, parent);
  return {
    ...feed,
    parentSourceId: parent.id,
    policyIds: [parent.id, feed.id],
    selectionState: child.selectionState,
  };
}

/**
 * Replaces each catalogue parent that lists `approvedChildren` with those
 * children before the scheduler sees them. The other snapshot children are
 * returned as `discovered`, for operators only, and are never scheduled. A
 * parent without `approvedChildren` manages its catalogue itself (fanning it
 * out at fetch time) and is scheduled as is; an empty list revokes every child.
 * Throws when an approved child is missing from the snapshot, cannot be
 * resolved, its rights do not admit it or its terms carry no review date, so a
 * bad approval fails at startup rather than at poll time. A discovered child
 * that cannot be resolved (an unknown licence, no data endpoint) is skipped
 * with a warning; a second snapshot child of an id already taken is skipped
 * with an error.
 */
export function materializeCatalogChildren(
  feeds: readonly CatalogFeed[],
  domains: readonly IngestDomain[],
): { scheduled: CatalogFeed[]; discovered: CatalogFeed[]; issues: CatalogIssue[] } {
  const scheduled: CatalogFeed[] = [];
  const discovered: CatalogFeed[] = [];
  const issues: CatalogIssue[] = [];

  for (const parent of feeds) {
    const approvedIds = parent.catalog?.approvedChildren;
    if (!parent.catalog || approvedIds === undefined) {
      scheduled.push(parent);
      continue;
    }
    const domain = domains.find((d) => d.id === parent.domain);
    if (!domain) throw new Error(`feed ${parent.id}: unknown domain ${parent.domain}`);
    const resolver = catalogResolverFor(parent, domain.resolvers);
    const byId = new Map<string, CatalogFeed>();
    for (const child of resolver.snapshot) {
      try {
        const feed = childFeed(parent, child);
        if (byId.has(feed.id)) {
          issues.push({
            level: "error",
            file: parent.file,
            feedId: feed.id,
            message: `${resolver.id} snapshot names child ${feed.id} more than once`,
          });
        } else byId.set(feed.id, feed);
      } catch (err) {
        const id = deriveFeedId({ ...parent, qualifier: child.qualifier });
        const why = err instanceof Error ? err.message : String(err);
        if (approvedIds.includes(id)) {
          throw new Error(
            `catalogue child ${id} approved by ${parent.id} cannot be resolved: ${why}`,
          );
        }
        issues.push({
          level: "warning",
          file: parent.file,
          feedId: id,
          message: `${resolver.id} snapshot child ${id} is skipped: ${why}`,
        });
      }
    }
    const children = [...byId.values()];
    for (const approvedId of approvedIds) {
      const child = byId.get(approvedId);
      if (!child) {
        throw new Error(
          `catalogue child ${approvedId} approved by ${parent.id} is absent from ${resolver.id} snapshot`,
        );
      }
      // Approval rests on a reviewed grant: the rights must admit the child and
      // the terms they come from must say when they were reviewed.
      if (
        child.selectionState !== "approved" ||
        !admitsCatalogChild(child.rights) ||
        !child.terms?.reviewedAt
      ) {
        throw new Error(`catalogue child ${approvedId} lacks affirmative admission evidence`);
      }
      scheduled.push(child);
    }
    const approved = new Set(approvedIds);
    discovered.push(...children.filter((child) => !approved.has(child.id)));
  }

  const ids = scheduled.map((feed) => feed.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("materialized catalogue produced duplicate ids");
  }
  return { scheduled, discovered, issues };
}

/**
 * Resolves a catalogue live, refreshing the vendored snapshot on success and
 * falling back to it on failure (Transitland's git-submodule resilience). Never
 * throws: a dead registry with an empty snapshot degrades to no children so the
 * surrounding fan-out preserves last-good rows.
 */
export async function resolveWithSnapshot(
  resolver: CatalogResolver,
  parent: CatalogParent,
  fetchFn: FetchFn = guardedFetch(),
): Promise<ChildFeed[]> {
  try {
    const children = await resolver.resolve(parent, fetchFn);
    try {
      await writeFile(resolver.snapshotPath, `${JSON.stringify(children, null, 2)}\n`);
    } catch (writeErr) {
      console.warn(
        `[catalog] ${resolver.id}: could not refresh snapshot ${resolver.snapshotPath}:`,
        writeErr instanceof Error ? writeErr.message : writeErr,
      );
    }
    return children;
  } catch (liveErr) {
    const why = liveErr instanceof Error ? liveErr.message : String(liveErr);
    if (resolver.snapshot.length === 0) {
      console.error(
        `[catalog] ${resolver.id}: live resolve failed (${why}) and the snapshot is empty`,
      );
      return [];
    }
    console.warn(`[catalog] ${resolver.id}: live resolve failed (${why}); using vendored snapshot`);
    return [...resolver.snapshot];
  }
}
