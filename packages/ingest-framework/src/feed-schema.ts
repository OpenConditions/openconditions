import { z } from "zod";

/** Per-key credential-acquisition guide (rendered in the admin panel). */
export const credentialSetupSchema = z
  .object({
    url: z.string().url().optional(),
    urlLabel: z.string().optional(),
    steps: z.array(z.string()).optional(),
    cost: z.string().optional(),
    notes: z.string().optional(),
    email: z
      .object({ to: z.string(), subject: z.string().optional(), body: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The FeedAuth discriminated union as data. Discriminating on `kind` recovers,
 * at the data boundary, the compile-time exhaustiveness the TS union gives
 * today: an unknown `kind` — or a variant missing a required env-var name —
 * fails to parse instead of being silently accepted.
 */
export const feedAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("query-key"),
      param: z.string(),
      envVar: z.string(),
      defaultValue: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("header-key"),
      header: z.string(),
      envVar: z.string(),
      valuePrefix: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("basic"), userEnvVar: z.string(), passEnvVar: z.string() }).strict(),
  z.object({ kind: z.literal("bearer"), envVar: z.string() }).strict(),
  z
    .object({
      kind: z.literal("oauth2-client-credentials"),
      tokenUrl: z.string().url(),
      clientIdEnvVar: z.string(),
      clientSecretEnvVar: z.string(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mtls"),
      certEnvVar: z.string(),
      keyEnvVar: z.string(),
      caEnvVar: z.string().optional(),
    })
    .strict(),
]);

/**
 * Raw per-field shape mirroring FeedSourceBase exactly. Exported as a shape (not
 * just the built schema) so a domain can spread it into its own `.strict()`
 * superset (roads adds geojson/siteTable/…) without losing strictness.
 */
export const feedSourceBaseShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  format: z.string().min(1),
  produces: z.enum(["events", "flow"]).optional(),
  url: z.union([z.string(), z.array(z.string()).nonempty()]).optional(),
  expandEnv: z.string().optional(),
  catalog: z
    .object({ resolver: z.string().min(1), filter: z.record(z.string(), z.unknown()).optional() })
    .strict()
    .optional(),
  auth: feedAuthSchema.optional(),
  method: z.enum(["GET", "POST"]).optional(),
  bodyTemplate: z.string().optional(),
  requestHeaders: z.record(z.string(), z.string()).optional(),
  requiredEnv: z.array(z.string()).optional(),
  fetchIntervalSec: z.number().int().positive().optional(),
  preFetch: z.string().optional(),
  gzip: z.boolean().optional(),
  cadenceSec: z.number().int().positive(),
  freshnessWindowSec: z.number().int().positive(),
  license: z.string().min(1),
  licenseUrl: z.string().url().optional(),
  attribution: z.string().min(1),
  country: z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2, uppercase"),
  privacyUrl: z.string().url(),
  maintainers: z
    .array(z.object({ name: z.string().min(1), github: z.string().min(1) }).strict())
    .optional(),
  setup: z
    .record(
      z.string(),
      credentialSetupSchema.extend({ title: z.string(), description: z.string().optional() })
    )
    .optional(),
  enabledByDefault: z.boolean(),
} as const;

/** The domain-agnostic feed schema. `.strict()` — an unknown key is an error. */
export const feedSourceBaseSchema = z.object(feedSourceBaseShape).strict();
