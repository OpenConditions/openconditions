import { z } from "zod";

type BBox = [number, number, number, number];

/**
 * Parse a `west,south,east,north` query param into a BBox, rejecting malformed
 * or out-of-domain input rather than silently substituting a wrong value.
 *
 * NOTE: this is a byte-identical copy of `parseBbox` in OpenMapX's
 * `integrations/road-conditions/index.ts` — there is no shared package either
 * side imports from, so any future change here must be mirrored there too.
 */
export function parseBbox(raw: string | undefined): BBox | null {
  if (typeof raw !== "string" || !raw) return null;
  const segments = raw.split(",");
  // Reject blank segments explicitly — `Number("")` is `0` (finite), so
  // "1,,3,4" would otherwise silently parse to [1, 0, 3, 4] instead of
  // being rejected as malformed.
  if (segments.length !== 4 || segments.some((s) => s.trim() === "")) return null;
  const parts = segments.map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts as BBox;
  if (west < -180 || west > 180 || east < -180 || east > 180) return null;
  if (south < -90 || south > 90 || north < -90 || north > 90) return null;
  if (south > north) return null;
  // west > east would describe an antimeridian-crossing box; those are not
  // supported downstream (bbox intersection assumes west <= east), so reject
  // rather than silently returning empty/wrong results.
  if (west > east) return null;
  return parts as BBox;
}

const list = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

const bbox = z
  .string()
  .describe("west,south,east,north in WGS84 degrees")
  .transform((value, ctx) => {
    const parsed = parseBbox(value);
    if (parsed === null) {
      ctx.addIssue({ code: "custom", message: "bbox must be west,south,east,north" });
      return z.NEVER;
    }
    return parsed;
  });

/** Query of a situation collection: filters, the instant it is current at, and the page. */
export const SituationListQuery = z.strictObject({
  bbox: bbox.optional(),
  kind: list.describe("comma-separated kind codes").optional(),
  type: list.describe("comma-separated type codes").optional(),
  domain: z.string().min(1).optional(),
  source: list.describe("comma-separated source ids").optional(),
  origin: list.describe("comma-separated origins: feed, crowd, federation, derived").optional(),
  minSeverity: z.enum(["minor", "moderate", "major", "critical"]).optional(),
  at: z.iso.datetime({ offset: true }).describe("the instant situations are current at").optional(),
  horizonDays: z.coerce
    .number()
    .int()
    .min(0)
    .max(366)
    .describe("only situations starting within this many days after `at`")
    .optional(),
  cursor: z.string().min(1).describe("the `next` of the previous page").optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  dedupe: z
    .enum(["0", "1"])
    .describe("1 folds one phenomenon reported by several sources into one situation")
    .optional(),
});

export type SituationListQuery = z.output<typeof SituationListQuery>;

/** Query of the live stream: the collection's filters, evaluated now, without paging. */
export const StreamQuery = SituationListQuery.pick({
  bbox: true,
  kind: true,
  type: true,
  domain: true,
  source: true,
  origin: true,
  minSeverity: true,
}).extend({
  class: z
    .enum(["situation"])
    .describe("the record class streamed; observations are not")
    .optional(),
});

export type StreamQuery = z.output<typeof StreamQuery>;

/** Query of a single record or history read: the instant effect states are evaluated at. */
export const AtQuery = z.strictObject({
  at: z.iso.datetime({ offset: true }).optional(),
});

/** The classes whose records keep revisions. */
export const RecordClassParam = z.enum(["situation", "feature", "offer"]);

/** A request whose query does not parse, as the 400 body. */
export function queryError(error: z.ZodError): { error: string; issues: unknown[] } {
  return {
    error: "invalid query",
    issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  };
}
