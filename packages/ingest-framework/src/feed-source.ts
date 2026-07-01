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

/** Per-key credential-acquisition guide (rendered in the admin panel; owned by L3). */
export interface CredentialSetup {
  url?: string;
  urlLabel?: string;
  steps?: string[];
  cost?: string;
  notes?: string;
  email?: { to: string; subject?: string; body?: string };
}

/**
 * The domain-agnostic feed descriptor. A domain narrows `format` and adds
 * domain-specific mapping fields via intersection (e.g. roads adds `geojson`).
 * After L6 there are no function-valued fields.
 */
export interface FeedSourceBase {
  id: string;
  name: string;
  format: string;
  produces?: "events" | "flow";
  url?: string | string[];
  auth?: FeedAuth;
  method?: "GET" | "POST";
  requestHeaders?: Record<string, string>;
  requiredEnv?: string[];
  gzip?: boolean;
  cadenceSec: number;
  freshnessWindowSec: number;
  license: string;
  licenseUrl?: string;
  attribution: string;
  country: string;
  privacyUrl: string;
  enabledByDefault: boolean;
  setup?: Record<string, CredentialSetup>;
}
