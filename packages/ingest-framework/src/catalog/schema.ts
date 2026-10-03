import { ACCESS_MODES, SOURCE_TIERS } from "@openconditions/model";
import { type ZodRawShape, z } from "zod";
import { FEED_QUALIFIER, FEED_TOKEN } from "./ids.js";

const RAW_RETENTION_CLASSES = ["situation", "observation", "reference"] as const;

const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

export const credentialFieldSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    setup: credentialSetupSchema.optional(),
    optional: z.boolean().optional(),
    default: z.string().optional(),
  })
  .strict();

/** A field of the feed (`api_key`) or a shared field (`@group.field`). */
const credentialRef = z
  .string()
  .regex(/^(@[a-z0-9]+(-[a-z0-9]+)*\.)?[a-z][a-z0-9_]*$/, "credential reference");

/**
 * The feed auth union as data. Discriminating on `kind` makes an unknown kind,
 * or a variant missing a credential, fail to parse. Every credential value is a
 * reference to a declared field, never an env var name.
 */
export const feedAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("query-key"), param: z.string(), credential: credentialRef }).strict(),
  z
    .object({
      kind: z.literal("header-key"),
      header: z.string(),
      credential: credentialRef,
      valuePrefix: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("basic"), user: credentialRef, password: credentialRef }).strict(),
  z.object({ kind: z.literal("bearer"), credential: credentialRef }).strict(),
  z
    .object({
      kind: z.literal("oauth2-client-credentials"),
      tokenUrl: z.string().url(),
      clientId: credentialRef,
      clientSecret: credentialRef,
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mtls"),
      cert: credentialRef,
      key: credentialRef,
      ca: credentialRef.optional(),
    })
    .strict(),
]);

export const endpointSchema = z
  .object({
    url: z.string().min(1).optional(),
    urls: z.array(z.string().min(1)).nonempty().optional(),
    reference: z
      .object({
        kind: z.literal("mobilithek"),
        offerId: z.string().min(1),
        fileNamePrefix: z.string().min(1),
      })
      .strict()
      .optional(),
    expand: z.string().min(1).optional(),
    fanout: z.enum(["all", "tolerant"]).optional(),
    method: z.enum(["GET", "POST"]).optional(),
    body: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    pagination: z
      .object({
        skipParam: z.string(),
        pageSize: z.number().int().positive(),
        recordsPath: z.string().optional(),
        maxPages: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    gzip: z.boolean().optional(),
    decoder: z.string().min(1).optional(),
    cadenceSec: z.number().int().positive(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const sources = [e.url, e.urls, e.reference].filter((s) => s !== undefined).length;
    if (sources !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of url, urls or reference is required",
      });
    }
    if (e.reference && !e.decoder) {
      ctx.addIssue({ code: "custom", path: ["decoder"], message: "reference requires a decoder" });
    }
    if (e.fanout && !e.urls && !e.expand) {
      ctx.addIssue({ code: "custom", path: ["fanout"], message: "fanout requires urls or expand" });
    }
  });

/** A feed's own terms; see `FeedTerms`. */
export const feedTermsSchema = z
  .object({
    url: z.string().url().optional(),
    reviewedAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
    note: z.string().min(1).optional(),
    redistribution: z.boolean().nullable().optional(),
    derivedRedistribution: z.boolean().nullable().optional(),
    commercialUse: z.boolean().nullable().optional(),
    attributionRequired: z.boolean().nullable().optional(),
    retention: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((t) => t.url !== undefined || t.note !== undefined, {
    message: "terms need a url or a note",
  });

/**
 * Raw per-field shape of a feed. Exported as a shape (not just the built schema)
 * so a domain can spread it into its own `.strict()` superset without losing
 * strictness.
 */
export const feedBaseShape = {
  subdivision: z
    .string()
    .regex(FEED_TOKEN, "lower-case alphanumeric slug (ISO 3166-2 or city slug)")
    .optional(),
  operator: z.string().regex(FEED_TOKEN, "lower-case alphanumeric slug"),
  qualifier: z.string().regex(FEED_QUALIFIER, "lower-case dash-joined slug").optional(),
  product: z.string().regex(FEED_TOKEN, "lower-case alphanumeric slug"),
  name: z.string().min(1),
  format: z.string().min(1),
  tier: z.enum(SOURCE_TIERS),
  endpoints: z
    .record(z.string().regex(FIELD_NAME, "lower-case role name"), endpointSchema)
    .refine((e) => Object.keys(e).length >= 1, { message: "at least one endpoint is required" }),
  credentials: z
    .record(z.string().regex(FIELD_NAME, "lower-case field name"), credentialFieldSchema)
    .optional(),
  auth: feedAuthSchema.optional(),
  catalog: z
    .object({
      resolver: z.string().min(1),
      filter: z.record(z.string(), z.unknown()).optional(),
      approvedChildren: z.array(z.string().min(1)).optional(),
    })
    .strict()
    .optional(),
  snapshot: z
    .object({
      completeness: z.literal("complete"),
      recordsPath: z.string().min(1).optional(),
      rootElement: z.string().min(1).optional(),
      publicationElement: z.string().min(1).optional(),
      publicationType: z.string().min(1).optional(),
      recordElement: z.string().min(1).optional(),
      totalCountPath: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((snapshot, ctx) => {
      if (snapshot.recordsPath && snapshot.recordElement) {
        ctx.addIssue({
          code: "custom",
          message: "snapshot recordsPath and recordElement are mutually exclusive",
        });
      }
      if (snapshot.recordElement) {
        for (const field of ["rootElement", "publicationElement", "publicationType"] as const) {
          if (!snapshot[field]) {
            ctx.addIssue({
              code: "custom",
              path: [field],
              message: `${field} is required for XML snapshot validation`,
            });
          }
        }
      }
      if (snapshot.totalCountPath && !snapshot.recordsPath) {
        ctx.addIssue({
          code: "custom",
          path: ["totalCountPath"],
          message: "totalCountPath requires recordsPath",
        });
      }
    })
    .optional(),
  freshnessWindowSec: z.number().int().positive(),
  accessMode: z.enum(ACCESS_MODES).optional(),
  requestLimits: z
    .object({
      perMinute: z.number().int().positive().optional(),
      perDay: z.number().int().positive().optional(),
      maxRadiusKm: z.number().positive().optional(),
      keyScope: z.enum(["instance", "consumer"]).optional(),
    })
    .strict()
    .optional(),
  extrasAllow: z.array(z.string().min(1)).optional(),
  extrasFederate: z.boolean().optional(),
  rawRetention: z.enum(RAW_RETENTION_CLASSES).optional(),
  license: z.string().min(1),
  licenseUrl: z.string().url().optional(),
  attribution: z.string().min(1),
  terms: feedTermsSchema.optional(),
  privacyUrl: z.string().url(),
  coverage: z
    .object({
      // A national feed names its country; a narrower one its subdivisions.
      countries: z
        .array(
          z
            .string()
            .regex(
              /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/,
              "ISO 3166-1 alpha-2 or ISO 3166-2 code, uppercase",
            ),
        )
        .optional(),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    })
    .strict()
    .optional(),
  disabled: z
    .object({ reason: z.string().min(1), since: z.iso.date() })
    .strict()
    .optional(),
} as const;

/** A `feeds/<domain>/<region>.jsonc` file; the domain supplies its own feed shape. */
export function regionFileSchema(feedShape: ZodRawShape) {
  return z
    .object({
      $schema: z.string().optional(),
      maintainers: z
        .array(z.object({ name: z.string().min(1), github: z.string().min(1) }).strict())
        .optional(),
      feeds: z.array(z.object(feedShape).strict()),
    })
    .strict();
}

/** `feeds/credentials.jsonc`: credential fields shared by several feeds, by group. */
export const credentialsFileSchema = z
  .object({
    $schema: z.string().optional(),
    credentials: z.record(
      z.string().regex(SLUG, "feed-id-shaped slug"),
      z.record(z.string().regex(FIELD_NAME, "lower-case field name"), credentialFieldSchema),
    ),
  })
  .strict();
