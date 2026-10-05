import { assertPublicUrl } from "../egress.js";
import { cellRadiusKm, usesCellPlaceholder } from "./cells.js";
import { credentialEnvName, credentialRefs, isSettingsGroup } from "./credentials.js";
import type { IngestDomain } from "./domain.js";
import { deriveFeedId } from "./ids.js";
import { licenseInfo } from "./licenses.js";
import type { CatalogFile, SharedCredentials } from "./load.js";
import { toCatalogFeed } from "./resolve.js";
import {
  type CatalogResolver,
  catalogResolverFor,
  materializeCatalogChildren,
  registryUrl,
} from "./resolvers.js";
import type { FeedDefinition } from "./types.js";

/** One finding of the catalogue checks; an `error` stops the catalogue from loading. */
export interface CatalogIssue {
  level: "error" | "warning";
  file: string;
  feedId?: string;
  message: string;
}

/** The file of shared credentials, beside the domain directories. */
export const CREDENTIALS_FILE = "credentials.jsonc";

/** An issue as one line: `file: feed-id: message`. */
export function formatCatalogIssue(issue: CatalogIssue): string {
  return [issue.file, issue.feedId, issue.message].filter(Boolean).join(": ");
}

/** The `$schema` a region file of `domain` names, relative to the file. */
export function regionFileSchemaRef(domain: string): string {
  return `../schema/${domain}.schema.json`;
}

/** The URLs a feed fetches that are written out in full: no `${…}` placeholder. */
function staticFetchUrls(feed: FeedDefinition): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  for (const [role, endpoint] of Object.entries(feed.endpoints)) {
    for (const url of endpoint.urls ?? (endpoint.url ? [endpoint.url] : [])) {
      out.push({ label: `endpoint ${role} URL`, url });
    }
  }
  if (feed.auth?.kind === "oauth2-client-credentials") {
    out.push({ label: "auth tokenUrl", url: feed.auth.tokenUrl });
  }
  return out.filter(({ url }) => !url.includes("${"));
}

/** A feed's id from its definition and the region of the file it is written in. */
export function feedIdIn(file: CatalogFile, feed: FeedDefinition): string {
  return deriveFeedId({ region: file.region, ...feed });
}

/** Ids written twice across the files of every domain, each naming both files. */
export function duplicateIdIssues(files: readonly CatalogFile[]): CatalogIssue[] {
  const first = new Map<string, string>();
  const issues: CatalogIssue[] = [];
  for (const file of files) {
    for (const feed of file.feeds) {
      const id = feedIdIn(file, feed);
      const seen = first.get(id);
      if (seen === undefined) first.set(id, file.path);
      else {
        issues.push({
          level: "error",
          file: file.path,
          feedId: id,
          message: `feed id ${id} is written in both ${seen} and ${file.path}`,
        });
      }
    }
  }
  return issues;
}

function formatIssues(feed: FeedDefinition, domain: IngestDomain): string[] {
  const out: string[] = [];
  if (!domain.products.includes(feed.product)) {
    out.push(
      `product ${feed.product} is not a ${domain.id} product (${domain.products.join(", ")})`,
    );
  }
  // Own keys only: a name like `toString` must not find an Object member.
  const format = Object.hasOwn(domain.formats, feed.format)
    ? domain.formats[feed.format]
    : undefined;
  if (!format) return [...out, `format ${feed.format} is unknown to domain ${domain.id}`];
  if (!format.products.includes(feed.product)) {
    out.push(`format ${feed.format} does not serve product ${feed.product}`);
  }
  for (const [role, spec] of Object.entries(format.endpoints)) {
    if (spec.required && !feed.endpoints[role]) {
      out.push(`required endpoint ${role} is missing (format ${feed.format})`);
    }
  }
  for (const [role, endpoint] of Object.entries(feed.endpoints)) {
    const spec = Object.hasOwn(format.endpoints, role) ? format.endpoints[role] : undefined;
    if (!spec) {
      out.push(`format ${feed.format} has no endpoint role ${role}`);
    } else if (spec.decoders === undefined) {
      if (endpoint.decoder !== undefined) out.push(`endpoint ${role} takes no decoder`);
    } else if (endpoint.decoder === undefined) {
      out.push(`endpoint ${role} needs a decoder (${spec.decoders.join(", ")})`);
    } else if (!spec.decoders.includes(endpoint.decoder)) {
      out.push(
        `endpoint ${role} decoder ${endpoint.decoder} is not one of ${spec.decoders.join(", ")}`,
      );
    }
  }
  return out;
}

/** The request texts of one endpoint that a cell placeholder may appear in. */
function requestTexts(endpoint: FeedDefinition["endpoints"][string]): string[] {
  return [
    endpoint.url,
    ...(endpoint.urls ?? []),
    endpoint.body,
    ...Object.values(endpoint.headers ?? {}),
  ].filter((text): text is string => text !== undefined);
}

function onDemandIssues(feed: FeedDefinition, domain: IngestDomain): string[] {
  const out: string[] = [];
  const onDemand = feed.accessMode === "on_demand";
  const usesCell = (endpoint: FeedDefinition["endpoints"][string]) =>
    requestTexts(endpoint).some(usesCellPlaceholder);

  if (!onDemand) {
    if (feed.onDemand) out.push("bulk feed cannot have onDemand");
    for (const [role, endpoint] of Object.entries(feed.endpoints)) {
      if (usesCell(endpoint)) out.push(`bulk feed endpoint ${role} uses a cell placeholder`);
    }
    return out;
  }

  if (!feed.onDemand) out.push("on_demand feed needs onDemand");
  const bbox = feed.coverage?.bbox;
  if (!bbox) out.push("on_demand feed needs coverage.bbox");
  const format = Object.hasOwn(domain.formats, feed.format)
    ? domain.formats[feed.format]
    : undefined;
  if (format && (format.kind !== "features" || !format.produces)) {
    out.push(`format ${feed.format} must be a features format that declares produces`);
  }
  const dataEndpoints = Object.values(feed.endpoints).filter((e) => e.decoder === undefined);
  if (!dataEndpoints.some(usesCell)) {
    out.push("on_demand feed needs a data endpoint that uses a cell placeholder");
  }
  if (feed.onDemand && bbox) {
    const [lon, lat] = feed.onDemand.probe;
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) {
      out.push(`onDemand probe outside coverage.bbox ([${lon}, ${lat}])`);
    }
  }
  const maxRadiusKm = feed.requestLimits?.maxRadiusKm;
  if (feed.onDemand && maxRadiusKm !== undefined) {
    const { cellDeg } = feed.onDemand;
    const radius = cellRadiusKm({ id: "", west: 0, south: 0, east: cellDeg, north: cellDeg });
    if (maxRadiusKm < radius) {
      out.push(
        `requestLimits.maxRadiusKm ${maxRadiusKm} is below the ${radius} km radius of a ${cellDeg} degree cell`,
      );
    }
  }
  return out;
}

/** The group of a shared ref (`@group.field`); undefined for a feed field. */
function sharedGroup(ref: string): string | undefined {
  return ref.startsWith("@") ? ref.slice(1).split(".")[0] : undefined;
}

function isDeclared(ref: string, feed: FeedDefinition, shared: SharedCredentials): boolean {
  const group = sharedGroup(ref);
  if (group === undefined) return Object.hasOwn(feed.credentials ?? {}, ref);
  const field = ref.slice(group.length + 2);
  return Object.hasOwn(shared.groups, group) && Object.hasOwn(shared.groups[group]!, field);
}

function credentialIssues(feed: FeedDefinition, shared: SharedCredentials): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  for (const { ref } of credentialRefs(feed)) {
    used.add(ref);
    if (!isDeclared(ref, feed, shared)) {
      out.push(`credential ${ref} is neither a feed field nor a shared field`);
    }
  }
  for (const field of Object.keys(feed.credentials ?? {})) {
    if (!used.has(field)) out.push(`credential ${field} is never used`);
  }
  return out;
}

/** A declared credential field: the env var it is read from, and who declares it where. */
interface CredentialDeclaration {
  env: string;
  /** `feed <owner> field <field>` or `shared field @<group>.<field>`; two are one when equal. */
  label: string;
  file: string;
  feedId?: string;
}

/** The fields a feed (or a catalogue child, under its parent's id) declares. */
function feedDeclarations(
  ownerId: string,
  feed: Pick<FeedDefinition, "credentials">,
  file: string,
  feedId: string,
): CredentialDeclaration[] {
  return Object.keys(feed.credentials ?? {}).map((field) => ({
    env: credentialEnvName(ownerId, field),
    label: `feed ${ownerId} field ${field}`,
    file,
    feedId,
  }));
}

/**
 * Two declarations that read one env var (`<OWNER>_<FIELD>` read with `-` as
 * `_`, so `xx-op-flow` `events_k` and `xx-op-flow-events` `k` are one name; and
 * a credential is also read from `<NAME>_FILE`, so a field `k_file` is `k`'s
 * file): each would read the other's value. The later one is the error,
 * naming both.
 */
function envNameIssues(declarations: readonly CredentialDeclaration[]): CatalogIssue[] {
  const first = new Map<string, { declaration: CredentialDeclaration; as: string }>();
  const issues: CatalogIssue[] = [];
  const described = ({ declaration, as }: { declaration: CredentialDeclaration; as: string }) =>
    as === declaration.env ? declaration.label : `${declaration.label} (as ${as})`;
  // One issue per pair: two names alike share their `_FILE` variants too.
  const reported = new Set<string>();
  for (const declaration of declarations) {
    for (const name of [declaration.env, `${declaration.env}_FILE`]) {
      const read = { declaration, as: name };
      const seen = first.get(name);
      const pair = `${seen?.declaration.label}\n${declaration.label}`;
      if (seen === undefined) first.set(name, read);
      else if (seen.declaration.label !== declaration.label && !reported.has(pair)) {
        reported.add(pair);
        issues.push({
          level: "error",
          file: declaration.file,
          ...(declaration.feedId ? { feedId: declaration.feedId } : {}),
          message: `credential env name ${name} is derived by both ${described(seen)} and ${described(read)}`,
        });
      }
    }
  }
  return issues;
}

function rightsIssues(feed: FeedDefinition): string[] {
  if (!licenseInfo(feed.license)) return [`unknown licence ${feed.license}`];
  if (feed.license === "NOASSERTION" && !feed.terms) {
    return ["licence NOASSERTION needs terms saying what is known"];
  }
  return [];
}

function urlIssues(feed: FeedDefinition): string[] {
  const out: string[] = [];
  for (const { label, url } of staticFetchUrls(feed)) {
    try {
      assertPublicUrl(url);
    } catch (err) {
      out.push(`${label} ${url} is not public: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * The catalogue as a whole, checked: unique ids across every domain; products,
 * formats, endpoint roles and decoders the domain declares; every credential
 * ref declared and every declared field used, a shared group serving at least
 * two feeds (one when every field has a default: a group of settings), no two
 * declared fields read from one env var (or its `_FILE`);
 * known licences, `NOASSERTION` with terms; public static URLs; the domain's
 * `$schema` and its own feed checks (`lintFeed`); no future `disabled.since`; and catalogue parents with a usable
 * registry URL, one per resolver, whose children resolve. Disabled feeds are
 * checked like the rest.
 */
export function lintCatalog(
  files: CatalogFile[],
  credentials: SharedCredentials,
  domains: readonly IngestDomain[],
  now: Date = new Date(),
): CatalogIssue[] {
  const issues = duplicateIdIssues(files);
  const today = now.toISOString().slice(0, 10);
  const groupUsers = new Map<string, number>();
  const resolverParents = new Map<CatalogResolver, { id: string; file: string }>();
  const declarations: CredentialDeclaration[] = Object.entries(credentials.groups).flatMap(
    ([group, fields]) =>
      Object.keys(fields).map((field) => ({
        env: credentialEnvName("", `@${group}.${field}`),
        label: `shared field @${group}.${field}`,
        file: CREDENTIALS_FILE,
      })),
  );

  for (const file of files) {
    const error = (message: string, feedId?: string) =>
      issues.push({ level: "error", file: file.path, ...(feedId ? { feedId } : {}), message });

    const domain = domains.find((d) => d.id === file.domain);
    if (!domain) {
      error(`unknown domain ${file.domain}`);
      continue;
    }
    if (file.$schema !== regionFileSchemaRef(domain.id)) {
      error(`$schema must be "${regionFileSchemaRef(domain.id)}"`);
    }

    for (const feed of file.feeds) {
      const id = feedIdIn(file, feed);
      const groups = new Set(credentialRefs(feed).map(({ ref }) => sharedGroup(ref)));
      for (const group of groups) {
        if (group !== undefined) groupUsers.set(group, (groupUsers.get(group) ?? 0) + 1);
      }

      const messages = [
        ...formatIssues(feed, domain),
        ...onDemandIssues(feed, domain),
        ...credentialIssues(feed, credentials),
        ...rightsIssues(feed),
        ...urlIssues(feed),
        ...(domain.lintFeed?.(feed) ?? []),
      ];
      if (feed.disabled && feed.disabled.since > today) {
        messages.push(`disabled.since ${feed.disabled.since} is in the future`);
      }
      for (const message of messages) error(message, id);
      declarations.push(...feedDeclarations(id, feed, file.path, id));

      if (!licenseInfo(feed.license)) continue;
      try {
        const resolved = toCatalogFeed(feed, {
          domain: file.domain,
          region: file.region,
          file: file.path,
          maintainers: file.maintainers,
          shared: credentials.groups,
        });
        if (resolved.catalog) {
          const resolver = catalogResolverFor(resolved, domain.resolvers);
          // The snapshot, approved children and atlas entry are the resolver's:
          // a second parent would be handed the first one's registry.
          const parent = resolverParents.get(resolver);
          if (parent) {
            error(
              `catalogue resolver ${resolver.id} is already named by ${parent.id} (${parent.file}); a resolver serves one parent`,
              id,
            );
          } else resolverParents.set(resolver, { id, file: file.path });
          registryUrl(resolved, resolver.id);
          issues.push(...materializeCatalogChildren([resolved], [domain]).issues);
          // A child's own fields are read under its parent's names.
          for (const child of resolver.snapshot) {
            declarations.push(...feedDeclarations(id, child, file.path, id));
          }
        }
      } catch (err) {
        error((err as Error).message, id);
      }
    }
  }

  for (const [group, fields] of Object.entries(credentials.groups)) {
    const n = groupUsers.get(group) ?? 0;
    // A group of settings (where the instance reaches a service) is not an
    // account: one is shared by the feeds that will read it from the first on.
    const settings = isSettingsGroup(fields);
    const least = settings ? 1 : 2;
    if (n < least) {
      issues.push({
        level: "error",
        file: CREDENTIALS_FILE,
        message: `shared group ${group} is used by ${n} feed${n === 1 ? "" : "s"}; ${settings ? "a group of settings serves at least one" : "a group serves at least two"}`,
      });
    }
  }
  issues.push(...envNameIssues(declarations));
  return issues;
}
