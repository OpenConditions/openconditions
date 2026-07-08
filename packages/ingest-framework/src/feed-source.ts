/** How a feed authenticates. Discriminated union; secrets live only in env. */
export type FeedAuth =
  | { kind: "none" }
  | { kind: "query-key"; param: string; envVar: string; defaultValue?: string }
  | { kind: "header-key"; header: string; envVar: string; valuePrefix?: string }
  | { kind: "basic"; userEnvVar: string; passEnvVar: string }
  | { kind: "bearer"; envVar: string }
  | {
      kind: "oauth2-client-credentials";
      tokenUrl: string;
      clientIdEnvVar: string;
      clientSecretEnvVar: string;
      scope?: string;
    }
  | { kind: "mtls"; certEnvVar: string; keyEnvVar: string; caEnvVar?: string };

/** Per-key credential-acquisition guide (rendered in the admin panel). */
export interface CredentialSetup {
  url?: string;
  urlLabel?: string;
  steps?: string[];
  cost?: string;
  notes?: string;
  email?: { to: string; subject?: string; body?: string };
}

/**
 * A per-env-var credential field: the admin-panel label/description alongside
 * the acquisition guide. Generated into `service.json`'s `configSchema`
 * properties by `pnpm gen:credentials`.
 */
export interface CredentialField extends CredentialSetup {
  /** Admin-panel field label (e.g. "511NY API key (New York)"). */
  title: string;
  /** Short field description shown under the label. */
  description?: string;
}

/**
 * The domain-agnostic feed descriptor. A domain narrows `format` and adds
 * domain-specific mapping fields via intersection (e.g. roads adds `geojson`).
 * After the declarative-templating work, no feed field holds a function.
 */
export interface FeedSourceBase {
  id: string;
  name: string;
  format: string;
  produces?: "events" | "flow";
  url?: string | string[];
  /** Names a comma-separated env var to fan `url` out over, one resolved URL per item. */
  expandEnv?: string;
  /**
   * A declarative reference into a registry/catalog resolver (replaces the old
   * `discover` closure). The named resolver is looked up in the domain's catalog
   * registry and expanded into concrete feeds at fetch time; `filter` narrows the
   * resolved set (a shallow equality match on the resolved descriptors).
   */
  catalog?: { resolver: string; filter?: Record<string, unknown> };
  auth?: FeedAuth;
  method?: "GET" | "POST";
  /** POST-body template; `${VAR}` interpolated from resolvedEnv, same as `url`. */
  bodyTemplate?: string;
  requestHeaders?: Record<string, string>;
  requiredEnv?: string[];
  /** Skip a fetch cycle when the source was fetched within this many seconds. */
  fetchIntervalSec?: number;
  /** Name of a PRE_FETCH_HOOKS entry that rewrites this feed before fetch. Dormant — no hooks registered. */
  preFetch?: string;
  /**
   * Route this feed's multi-URL fan-out through the tolerant `fetchFanout`
   * (per-URL skip-and-continue) instead of the all-or-nothing static path —
   * for large fan-outs where one transient sub-URL failure must not drop the
   * whole cycle.
   */
  fanoutTolerant?: boolean;
  /**
   * Opts this feed out of the event-feed shrink tripwire in `runSource` (see
   * `OPENCONDITIONS_SHRINK_TRIPWIRE_RATIO`): a feed whose row count can
   * legitimately collapse to zero or near-zero between cycles (e.g. a
   * seasonal/short-lived event catalog) sets this so its swap always proceeds
   * instead of being skipped as a suspected partial-failure wipe. Defaults to
   * false — a real, unexpected drop is far more common than a legitimate mass
   * clear, so the safe default guards every feed unless it opts out.
   */
  allowMassClear?: boolean;
  gzip?: boolean;
  cadenceSec: number;
  freshnessWindowSec: number;
  license: string;
  licenseUrl?: string;
  attribution: string;
  country: string;
  privacyUrl: string;
  /**
   * Optional feed owner(s). Each entry names a person and their GitHub handle so
   * the scheduled liveness check can @-mention them when the feed goes dark.
   * Pure declarative data — no secrets, safe to commit.
   */
  maintainers?: { name: string; github: string }[];
  enabledByDefault: boolean;
  /** Per-env-var credential guide (title, description, acquisition steps). */
  setup?: Record<string, CredentialField>;
}
