import {
  CREDENTIAL_PLACEHOLDER,
  type CredentialRef,
  type Env,
  type FeedCredentialName,
  feedCredentialNames,
  resolveCredential,
} from "./credentials.js";
import type { CatalogFeed, FeedEndpoint } from "./types.js";

/** A feed's endpoint by role; throws on a role the feed does not have. */
export function feedEndpoint(feed: CatalogFeed, role: string): FeedEndpoint {
  const endpoint = feed.endpoints[role];
  if (!endpoint) throw new Error(`feed ${feed.id} has no endpoint ${role}`);
  return endpoint;
}

/**
 * The credentials a template may name: the feed's own declared fields and shared
 * `@group.field` refs. Anything else — `${HOME}`, `${DATABASE_URL}` — throws
 * before any env lookup, so a template cannot read an arbitrary host variable.
 */
function templateNames(feed: CatalogFeed): Map<CredentialRef, FeedCredentialName> {
  return new Map(
    feedCredentialNames(feed)
      .filter((name) => name.ref.startsWith("@") || feed.credentials?.[name.ref] !== undefined)
      .map((name) => [name.ref, name]),
  );
}

function credentialValue(name: FeedCredentialName, env: Env): string | undefined {
  return resolveCredential(env, name.env) ?? name.default;
}

function fill(
  feed: CatalogFeed,
  template: string,
  names: Map<CredentialRef, FeedCredentialName>,
  env: Env,
  overrides: ReadonlyMap<CredentialRef, string> = new Map(),
): string {
  return template.replace(CREDENTIAL_PLACEHOLDER, (_match, ref: string) => {
    const name = names.get(ref);
    if (!name) throw new Error(`feed ${feed.id}: template names ${ref}, which is not a credential`);
    const value = overrides.get(ref) ?? credentialValue(name, env);
    if (value === undefined) {
      throw new Error(
        `feed ${feed.id}: template credential ${name.env} (or ${name.env}_FILE) is unset`,
      );
    }
    return value;
  });
}

/**
 * Fill `${field}` placeholders in one of a feed's request texts (a body, a
 * header value) from its credentials. A field resolves from its derived env var
 * or `_FILE` variant, else its `default`; an unset one throws.
 */
export function resolveFeedTemplate(
  feed: CatalogFeed,
  template: string,
  env: Env = process.env,
): string {
  return fill(feed, template, templateNames(feed), env);
}

/**
 * The concrete URLs of one endpoint. With `expand`, the named credential's value
 * is split on commas and every template is filled once per item — the
 * Mobilithek "one client-pull URL per subscription id" case, where the id sits
 * in both path and query. An empty `expand` value yields no URLs: a dormant feed.
 */
export function resolveEndpointUrls(
  feed: CatalogFeed,
  role: string,
  env: Env = process.env,
): string[] {
  const endpoint = feedEndpoint(feed, role);
  if (endpoint.reference) {
    throw new Error(`feed ${feed.id}: endpoint ${role} is a reference, not a URL`);
  }
  const templates = endpoint.urls ?? (endpoint.url ? [endpoint.url] : []);
  const names = templateNames(feed);
  if (!endpoint.expand) return templates.map((t) => fill(feed, t, names, env));

  const ref = endpoint.expand;
  const name = names.get(ref);
  if (!name) throw new Error(`feed ${feed.id}: expand names ${ref}, which is not a credential`);
  const items = (credentialValue(name, env) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.flatMap((item) =>
    templates.map((t) => fill(feed, t, names, env, new Map([[ref, item]]))),
  );
}
