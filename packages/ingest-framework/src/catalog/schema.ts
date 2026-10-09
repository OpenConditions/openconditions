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

/** The capturing groups of a pattern, or undefined when it is no regular expression. */
function patternGroups(pattern: string): number | undefined {
  try {
    // An alternative that matches the empty string reports every group.
    return (new RegExp(`${pattern}|`).exec("")?.length ?? 1) - 1;
  } catch {
    return undefined;
  }
}

/** Every `{utcDate…}` placeholder a request text writes is `{utcDate}` or `{utcDate-1}` … `{utcDate-7}`. */
function utcDatePlaceholdersValid(text: string): boolean {
  return [...text.matchAll(/\{utcDate[^}]*\}/g)].every((m) => /^\{utcDate(-[1-7])?\}$/.test(m[0]));
}

/**
 * A per-item endpoint: fetched once per item read from another role's payload.
 * Items are listed by `records` and `field` in a JSON payload (`pattern`
 * keeping the matching values, its group the item) or walked through
 * directory listings by `links`, one pattern per level.
 */
const eachSchema = z
  .object({
    role: z.string().min(1),
    records: z.string().min(1).optional(),
    field: z.string().min(1).optional(),
    pattern: z.string().min(1).optional(),
    links: z.array(z.string().min(1)).nonempty().optional(),
    keepSec: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((each, ctx) => {
    const listed = each.records !== undefined || each.field !== undefined;
    if (listed === (each.links !== undefined)) {
      ctx.addIssue({ code: "custom", message: "each needs exactly one of records+field or links" });
    }
    if (listed && (each.records === undefined || each.field === undefined)) {
      ctx.addIssue({ code: "custom", message: "each needs both records and field" });
    }
    if (each.links !== undefined) {
      for (const field of ["pattern", "keepSec"] as const) {
        if (each[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${field} applies to records, not links`,
          });
        }
      }
    }
    if (each.pattern !== undefined && !((patternGroups(each.pattern) ?? 0) >= 1)) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message: "pattern must be a regular expression with a group",
      });
    }
    for (const [i, link] of (each.links ?? []).entries()) {
      if (!((patternGroups(link) ?? 0) >= 1)) {
        ctx.addIssue({
          code: "custom",
          path: ["links", i],
          message: "a links pattern must be a regular expression with a group",
        });
      }
    }
  });

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
        mode: z.enum(["offset", "page"]).optional(),
        firstPage: z.number().int().nonnegative().optional(),
        recordsPath: z.string().optional(),
        maxPages: z.number().int().positive().optional(),
        /**
         * The JSON is converted from XML (data.go.kr): a list of one is the
         * item itself, and an empty list is absent or `""`.
         */
        xmlLists: z.literal(true).optional(),
      })
      .strict()
      .refine((p) => p.firstPage === undefined || p.mode === "page", {
        path: ["firstPage"],
        message: "firstPage applies to page mode only",
      })
      .optional(),
    follow: z
      .object({ path: z.string().min(1).optional(), pattern: z.string().min(1).optional() })
      .strict()
      .refine((f) => (f.path === undefined) !== (f.pattern === undefined), {
        message: "follow needs exactly one of path or pattern",
      })
      .refine(
        (f) => {
          if (f.pattern === undefined) return true;
          try {
            new RegExp(f.pattern);
            return true;
          } catch {
            return false;
          }
        },
        { path: ["pattern"], message: "pattern is not a valid regular expression" },
      )
      .optional(),
    /** Fetched once per item of another role's payload; the `url` names it as `{item}`. */
    each: eachSchema.optional(),
    /**
     * The response is a zip archive: the role's payloads are its entries whose
     * name matches `entries` (all without it), in name order, at most
     * `maxEntries` of them listed.
     */
    unzip: z
      .object({
        entries: z
          .string()
          .min(1)
          .refine((p) => patternGroups(p) !== undefined, {
            message: "entries is not a valid regular expression",
          })
          .optional(),
        maxEntries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    impersonate: z.boolean().optional(),
    gzip: z.boolean().optional(),
    decoder: z.string().min(1).optional(),
    cadenceSec: z.number().int().positive(),
    /**
     * A held answer of this role (the role's, or one URL's of a tolerant
     * `urls` role) older than this never stands in for a failed request: data
     * the publisher allows to be shown only while recent is never published
     * from an old copy. Unset, a held answer stands in at any age.
     */
    maxPayloadAgeSec: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.each) {
      if (e.url === undefined || !e.url.includes("{item}")) {
        ctx.addIssue({
          code: "custom",
          path: ["each"],
          message: "each needs a url that contains {item}",
        });
      }
      // A walked item is a URL found in a listing, fetched as found.
      if (e.each.links !== undefined && e.url !== "{item}") {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "each with links needs the url {item}",
        });
      }
      for (const field of ["urls", "expand", "follow", "pagination", "unzip"] as const) {
        if (e[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `each cannot be combined with ${field}`,
          });
        }
      }
    }
    if (e.unzip && e.pagination) {
      ctx.addIssue({ code: "custom", path: ["unzip"], message: "unzip cannot be paginated" });
    }
    for (const url of [e.url, ...(e.urls ?? [])]) {
      if (url !== undefined && !utcDatePlaceholdersValid(url)) {
        ctx.addIssue({
          code: "custom",
          message: "a date placeholder is {utcDate} or {utcDate-1} to {utcDate-7}",
        });
      }
    }
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
    if (e.fanout && !e.urls && !e.expand && !e.each) {
      ctx.addIssue({ code: "custom", path: ["fanout"], message: "fanout requires urls or expand" });
    }
    if (e.follow && e.pagination) {
      ctx.addIssue({ code: "custom", path: ["follow"], message: "follow cannot be paginated" });
    }
    if (e.impersonate) {
      const urls = e.url !== undefined ? [e.url] : (e.urls ?? []);
      if (e.reference || urls.length === 0 || !urls.every((u) => u.startsWith("https://"))) {
        ctx.addIssue({
          code: "custom",
          path: ["impersonate"],
          message: "impersonate requires https URLs",
        });
      }
    }
  });

/** A feed's own terms; see `FeedTerms`. */
export const feedTermsSchema = z
  .object({
    url: z.string().url().optional(),
    reviewedAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
    note: z.string().min(1).optional(),
    notice: z.string().min(1).optional(),
    redistribution: z.boolean().nullable().optional(),
    derivedRedistribution: z.boolean().nullable().optional(),
    commercialUse: z.boolean().nullable().optional(),
    attributionRequired: z.boolean().nullable().optional(),
    retention: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((t) => t.url !== undefined || t.note !== undefined || t.notice !== undefined, {
    message: "terms need a url, a note or a notice",
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
  onDemand: z
    .object({
      cellDeg: z.number().positive().max(1),
      ttlSec: z.number().int().positive(),
      maxCellsPerRead: z.number().int().min(1).max(64),
      probe: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
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
  /**
   * The publisher's site, where the attribution links to. Unwritten, it is the
   * origin of the first data endpoint, see `deriveHomepage`.
   */
  homepage: z
    .string()
    .url()
    .refine((url) => url.startsWith("https://"), { message: "homepage must be an https URL" })
    .optional(),
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
