import type { Env } from "./auth.js";
import { requiredEnvVars } from "./auth.js";
import type { FeedSourceBase } from "./feed-source.js";

const TOKEN = /\$\{([A-Za-z0-9_]+)\}/g;

/**
 * Interpolate `${VAR}` tokens in a URL or POST-body template from `env`
 * (pass a `resolvedEnv` view so `*_FILE`-backed secrets resolve). `allowed`
 * is the feed's own declared var set ({@link allowedTemplateVars}) — a token
 * naming any other variable throws BEFORE the env lookup, so a template
 * cannot exfiltrate an arbitrary host secret (e.g. `${DATABASE_URL}`) just
 * because that name happens to be set in the process env. A declared-but-unset
 * variable also throws — a template with an unfilled slot is a
 * misconfiguration, and the scheduler already skips keyed feeds without credentials.
 */
export function resolveUrlTemplate(
  template: string,
  env: Env,
  allowed: ReadonlySet<string>
): string {
  return template.replace(TOKEN, (_match, name: string) => {
    if (!allowed.has(name)) {
      throw new Error(`template references undeclared variable ${name}`);
    }
    const value = env[name];
    if (value == null || value === "") {
      throw new Error(`template references unset variable ${name}`);
    }
    return value;
  });
}

/**
 * The set of env-var names a feed's `url`/`bodyTemplate` templates may
 * reference: its auth-derived vars plus any extra `requiredEnv` it declares
 * (e.g. a key embedded in a POST body, or a Mobilithek subscription id).
 * This is the allowlist {@link resolveUrlTemplate} checks every `${NAME}`
 * token against — a template referencing a name outside this set throws
 * rather than silently resolving from the full process env.
 */
export function allowedTemplateVars(
  src: Pick<FeedSourceBase, "auth" | "requiredEnv">
): Set<string> {
  return new Set([...requiredEnvVars(src.auth), ...(src.requiredEnv ?? [])]);
}

/** Layer a single override over an env view without mutating the underlying source. */
function overlay(base: Env, key: string, value: string): Env {
  return new Proxy({} as Env, {
    get: (_t, prop) => (prop === key ? value : typeof prop === "string" ? base[prop] : undefined),
    has: (_t, prop) => prop === key || (typeof prop === "string" && prop in base),
  });
}

/**
 * Resolve the concrete URL set for a feed. `url` is one template or an array of
 * templates. When `expandEnv` names a comma-separated env var, the template set is
 * resolved once per item with that variable overridden to the item — the Mobilithek
 * "one client-pull URL per subscription id" case, where the id appears in both the
 * path and the query. An unset/empty `expandEnv` var yields no URLs (a dormant feed).
 */
export function resolveFeedUrls(
  src: Pick<FeedSourceBase, "url" | "expandEnv" | "id" | "auth" | "requiredEnv">,
  env: Env
): string[] {
  const templates = src.url == null ? [] : Array.isArray(src.url) ? src.url : [src.url];
  if (templates.length === 0) return [];
  const allowed = allowedTemplateVars(src);
  if (!src.expandEnv) return templates.map((t) => resolveUrlTemplate(t, env, allowed));

  const listVar = src.expandEnv;
  const items = (env[listVar] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.flatMap((item) =>
    templates.map((t) => resolveUrlTemplate(t, overlay(env, listVar, item), allowed))
  );
}
