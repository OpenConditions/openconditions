import { type Env, feedCredentialNames, resolveCredential } from "./catalog/credentials.js";
import type { CatalogFeed } from "./catalog/types.js";

/**
 * Secret values shorter than this are never redacted — blanking a 2-3
 * character value (a country code, a small numeric flag) would corrupt
 * unrelated text throughout a message instead of protecting anything.
 */
const MIN_SECRET_LENGTH = 6;

/**
 * Strip query-string VALUES from a URL for safe logging. Several feeds carry
 * credentials in query params (e.g. Buenos Aires' client_id/client_secret), and
 * fetch errors bubble the URL into logs — so redact every value while keeping the
 * path and param names for debugging. Falls back to the path on a parse failure.
 *
 * This is PATH-BLIND: a secret embedded in the URL path itself (e.g.
 * Mobilithek's `/subscription/<id>/clientPullService`) survives unredacted.
 * Use {@link redactSecrets} with the feed's own secret values to also scrub
 * path-embedded secrets.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/**
 * Replaces every occurrence of each secret value in `text` with `***`,
 * wherever it appears — URL path, query, or POST body — unlike
 * {@link redactUrl}'s syntax-based (query-values-only) scrubbing. This is
 * what catches a secret duplicated into the URL PATH, e.g. Mobilithek's
 * `/subscription/<id>/clientPullService?subscriptionID=<id>`, where
 * `redactUrl` only blanks the query copy and the path copy leaks through.
 *
 * Values shorter than {@link MIN_SECRET_LENGTH} (and empty/whitespace-only
 * values) are skipped, so a short, common substring — a country code, a
 * single digit — is never blanked; that would corrupt unrelated text instead
 * of protecting anything. Each value is used as a literal
 * `String.prototype.replaceAll` search string (the string overload, never
 * compiled to a `RegExp`), so a secret containing regex metacharacters can't
 * inject a pattern.
 */
export function redactSecrets(text: string, secretValues: Iterable<string>): string {
  // Redact the longest values first: if one declared secret is a substring of
  // another, a shorter value's replaceAll run first would blank part of the
  // longer value's occurrence, leaving a residual fragment of the real secret.
  // Longest-first guarantees the full secret is replaced before any of its
  // substrings can nibble at it.
  const values = [...secretValues]
    .filter((value) => value.trim().length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) {
    out = out.replaceAll(value, "***");
  }
  return out;
}

/**
 * A feed's own secret values: the resolved values of every credential it
 * reads ({@link feedCredentialNames} — its auth and the `${field}`s and
 * `expand` of its endpoints), filtered to non-empty values at least
 * {@link MIN_SECRET_LENGTH} long. Feed this to {@link redactSecrets} to scrub
 * a feed's credentials out of any string (URL, error message, log line) at
 * the source, before it ever reaches a log or the public feed-status route.
 * An `expand` list is also collected item by item, since each request URL
 * carries one item of it, not the whole list.
 */
export function feedSecretValues(feed: CatalogFeed, env: Env = process.env): string[] {
  const expanded = new Set(Object.values(feed.endpoints).map((e) => e.expand));
  const values: string[] = [];
  const add = (value: string) => {
    if (value.trim().length >= MIN_SECRET_LENGTH) values.push(value);
  };
  for (const name of feedCredentialNames(feed)) {
    const value = resolveCredential(env, name.env);
    if (value == null) continue;
    add(value);
    if (expanded.has(name.ref) && value.includes(",")) {
      for (const item of value.split(",")) add(item.trim());
    }
  }
  return values;
}
