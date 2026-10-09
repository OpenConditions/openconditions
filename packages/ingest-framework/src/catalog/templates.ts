import {
  CELL_PLACEHOLDER_NAMES,
  type Cell,
  type CellPlaceholderName,
  cellValues,
} from "./cells.js";
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

/**
 * One pass over every placeholder kind: `${field}` is a credential, `{west}` a
 * cell value and `{utcDate}` or `{utcDate-<n>}` the poll's UTC date, or the
 * date n days before it. A single pass means a credential's value is never
 * scanned for the others, and `${west}` stays a credential. A brace that is
 * none of them is left as written.
 */
const PLACEHOLDER = new RegExp(
  `${CREDENTIAL_PLACEHOLDER.source}|\\{(${CELL_PLACEHOLDER_NAMES.join("|")})\\}|\\{utcDate(?:-([1-7]))?\\}`,
  "g",
);

const DAY_MS = 86_400_000;

/** `YYYYMMDD` of the UTC day `daysBack` days before the instant. */
function utcDate(at: number, daysBack: number): string {
  return new Date(at - daysBack * DAY_MS).toISOString().slice(0, 10).replaceAll("-", "");
}

/** Whether a request text names a credential (`${field}`), as opposed to only cell values. */
export function referencesCredential(template: string): boolean {
  return [...template.matchAll(PLACEHOLDER)].some((m) => m[1] !== undefined);
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The base a setting's value names for a template that appends `path` to it:
 * the value without its trailing slashes and, when it already ends with that
 * path, without the path too. So `http://overpass:80/`, `http://overpass:80`
 * and `http://overpass:80/api/interpreter` all name `http://overpass:80`
 * for `/api/interpreter`. The path matches only whole: it starts with `/`. A
 * base URL carries no query or fragment; a value with one never ends with the
 * path, so it is taken as written apart from its trailing slashes.
 */
function settingBase(value: string, path: string): string {
  const base = withoutTrailingSlash(value);
  const tail = withoutTrailingSlash(path);
  return tail.startsWith("/") && base.endsWith(tail)
    ? withoutTrailingSlash(base.slice(0, -tail.length))
    : base;
}

/**
 * A setting's value joined to the path a reader appends: a base URL, with or
 * without a trailing slash, or the full URL it would make. The one rule for
 * `${@overpass.url}/api/interpreter` in a template and for a reader that is no
 * feed (the road-graph import).
 */
export function settingUrl(value: string, path: string): string {
  return `${settingBase(value, path)}${path}`;
}

/** The literal path a template writes right after `from`, up to its query, fragment or next placeholder. */
function literalPathAt(template: string, from: number): string {
  const rest = template.slice(from);
  if (!rest.startsWith("/")) return "";
  const end = rest.search(/[?#]|\$?\{/);
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Fills a template's placeholders. A feed's credential is filled verbatim. A
 * setting is a base URL (see {@link settingUrl}): its trailing slashes are
 * dropped, and so is a path it already ends with that the template appends.
 * A date is the poll's, `at` (epoch ms), now when unsaid.
 */
function fill(
  feed: CatalogFeed,
  template: string,
  names: Map<CredentialRef, FeedCredentialName>,
  env: Env,
  overrides: ReadonlyMap<CredentialRef, string> = new Map(),
  cell?: Cell,
  at?: number,
): string {
  const cellFill = cell ? cellValues(cell) : undefined;
  return template.replace(PLACEHOLDER, (match, ref: string | undefined, cellName, ...rest) => {
    const [daysBack, offset] = rest as [string | undefined, number];
    if (ref === undefined && cellName === undefined) {
      return utcDate(at ?? Date.now(), Number(daysBack ?? 0));
    }
    if (ref === undefined) {
      return cellFill ? cellFill[cellName as CellPlaceholderName] : match;
    }
    const name = names.get(ref);
    if (!name) throw new Error(`feed ${feed.id}: template names ${ref}, which is not a credential`);
    const value = overrides.get(ref) ?? credentialValue(name, env);
    if (value === undefined) {
      throw new Error(
        `feed ${feed.id}: template credential ${name.env} (or ${name.env}_FILE) is unset`,
      );
    }
    if (!name.setting) return value;
    return settingBase(value, literalPathAt(template, offset + match.length));
  });
}

/**
 * Fill `${field}` placeholders in one of a feed's request texts (a body, a
 * header value) from its credentials. A field resolves from its derived env var
 * or `_FILE` variant, else its `default`; an unset one throws. Cell values and
 * dates are filled in the same pass, dates for the poll instant `at`.
 */
export function resolveFeedTemplate(
  feed: CatalogFeed,
  template: string,
  env: Env = process.env,
  cell?: Cell,
  at?: number,
): string {
  return fill(feed, template, templateNames(feed), env, undefined, cell, at);
}

/**
 * An item as the path it fills into `{item}`: each `/`-separated segment
 * URL-encoded, the slashes kept. Undefined for an item that could leave the
 * path it is put in or end it: an empty, `.` or `..` segment, or a `?`, `#` or
 * `\`.
 */
export function eachItemPath(item: string): string | undefined {
  if (/[?#\\]/.test(item)) return undefined;
  const segments = item.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return undefined;
  return segments.map(encodeURIComponent).join("/");
}

/**
 * The URL of a per-item endpoint for one item: the item, encoded segment by
 * segment, goes into `{item}` before any other placeholder is filled, so an
 * item can never name a credential placeholder and a credential's value is
 * never scanned for `{item}`. A refused item (see {@link eachItemPath}) throws.
 */
export function resolveEachUrl(
  feed: CatalogFeed,
  role: string,
  item: string,
  env: Env = process.env,
  at?: number,
): string {
  const endpoint = feedEndpoint(feed, role);
  if (!endpoint.each || endpoint.url === undefined) {
    throw new Error(`feed ${feed.id}: endpoint ${role} is not a per-item endpoint`);
  }
  const path = eachItemPath(item);
  if (path === undefined) throw new Error(`feed ${feed.id}: item ${item} is refused`);
  const template = endpoint.url.replaceAll("{item}", () => path);
  return fill(feed, template, templateNames(feed), env, undefined, undefined, at);
}

/**
 * The concrete URLs of one endpoint. With `expand`, the named credential's value
 * is split on commas and every template is filled once per item — the
 * Mobilithek "one client-pull URL per subscription id" case, where the id sits
 * in both path and query. An empty `expand` value yields no URLs: a dormant feed.
 * Dates are filled for the poll instant `at`.
 */
export function resolveEndpointUrls(
  feed: CatalogFeed,
  role: string,
  env: Env = process.env,
  cell?: Cell,
  at?: number,
): string[] {
  const endpoint = feedEndpoint(feed, role);
  if (endpoint.reference) {
    throw new Error(`feed ${feed.id}: endpoint ${role} is a reference, not a URL`);
  }
  const templates = endpoint.urls ?? (endpoint.url ? [endpoint.url] : []);
  const names = templateNames(feed);
  if (!endpoint.expand) {
    return templates.map((t) => fill(feed, t, names, env, undefined, cell, at));
  }

  const ref = endpoint.expand;
  const name = names.get(ref);
  if (!name) throw new Error(`feed ${feed.id}: expand names ${ref}, which is not a credential`);
  const items = (credentialValue(name, env) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.flatMap((item) =>
    templates.map((t) => fill(feed, t, names, env, new Map([[ref, item]]), cell, at)),
  );
}
