import { gridCellCount, MAX_GRID_CELLS } from "@openconditions/core";
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

/** The longest time window a situation read may span. */
export const MAX_WINDOW_DAYS = 400;

const DAY_MS = 86_400_000;

/** The filters every situation read takes, the stream and the other collections picking from them. */
const SituationFilters = z.strictObject({
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
    .describe(
      "1 folds one phenomenon reported by several sources into one situation, within one page " +
        "only: the page is ordered by id, so reports of one phenomenon on different pages are " +
        "each returned. Request every record in one page (a large enough limit) for a complete fold",
    )
    .optional(),
});

/**
 * Query of a situation collection: filters, the instant it is current at or
 * a time window, the geometry's detail, and the page.
 */
export const SituationListQuery = SituationFilters.extend({
  subtype: list.describe("comma-separated subtype codes").optional(),
  from: z.iso
    .datetime({ offset: true })
    .describe(
      `start of a time window: situations whose validity overlaps [from, to], ended ones included and cancelled ones not, instead of those current at an instant; at most ${MAX_WINDOW_DAYS} days, not with at or horizonDays`,
    )
    .optional(),
  to: z.iso
    .datetime({ offset: true })
    .describe("end of the time window `from` starts; default now")
    .optional(),
  simplify: z.coerce
    .number()
    .gt(0)
    .max(1)
    .describe(
      "simplify each returned geometry with this tolerance in degrees (topology preserved), written with 6 decimals; the bbox filter reads the stored geometry",
    )
    .optional(),
}).superRefine((q, ctx) => {
  if (q.from === undefined) {
    if (q.to !== undefined) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to needs from" });
    }
    return;
  }
  for (const other of ["at", "horizonDays"] as const) {
    if (q[other] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [other],
        message: `from does not combine with ${other}`,
      });
    }
  }
  // A window ending now is checked against the server's clock by the route.
  if (q.to === undefined) return;
  const issue = windowIssue(new Date(q.from), new Date(q.to));
  if (issue !== undefined) ctx.addIssue({ code: "custom", path: ["from"], message: issue });
});

/** What is wrong with a situation read's time window, if anything. */
export function windowIssue(from: Date, to: Date): string | undefined {
  if (from > to) return "from must not be after to";
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return `the window may span at most ${MAX_WINDOW_DAYS} days`;
  }
  return undefined;
}

export type SituationListQuery = z.output<typeof SituationListQuery>;

/** Query of the live stream: the collection's filters, evaluated now, without paging. */
export const StreamQuery = SituationFilters.pick({
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

const at = (what: string) =>
  z.iso.datetime({ offset: true }).describe(`the instant ${what} are current at`).optional();
const cursor = z.string().min(1).describe("the `next` of the previous page").optional();
const limit = z.coerce.number().int().min(1).max(5000).default(500);
const canonical = (what: string) => z.enum(["0", "1"]).describe(`1 serves ${what}`).optional();

/** What a feature read can expand: comma-separated, each at most once in effect. */
const expand = (what: string) =>
  list
    .pipe(z.array(z.enum(["components", "latest", "offers"])))
    .describe(
      "comma-separated, of components, latest and offers. " +
        "latest adds each feature's readings in effect (in the canonical view under canonical component keys, a fused reading standing in for its members' and naming the sources it was fused from in contributors: source @fused for the operator, fused from every source; in public scope a fusion of public sources only, source @fused when every contributor is public, else @fused-public); " +
        `offers adds its live offers and those of its members and components. ${what}`,
    )
    .optional();

/** Query of a feature collection: filters, the canonical view, expansions, and the page. */
export const FeatureListQuery = z.strictObject({
  ...SituationFilters.pick({
    bbox: true,
    kind: true,
    type: true,
    domain: true,
    source: true,
    origin: true,
  }).shape,
  at: at("features, readings and offers"),
  canonical: canonical(
    "the canonical view: one feature per cluster of linked features, under its canonical id",
  ),
  expand: expand(
    "components includes each feature's components, which collections leave out. " +
      "The GeoJSON and JSON-LD collections take components only and ignore latest and offers.",
  ),
  cursor,
  limit,
});

export type FeatureListQuery = z.output<typeof FeatureListQuery>;

/** Query of one feature: the instant its readings and offers are current at, and expansions. */
export const FeatureQuery = z.strictObject({
  at: at("readings and offers"),
  expand: expand("A single feature always carries its components."),
});

export type FeatureQuery = z.output<typeof FeatureQuery>;

/** Query of an offer collection: filters, the instant offers are valid at, and the page. */
export const OfferListQuery = z.strictObject({
  ...SituationFilters.pick({
    bbox: true,
    kind: true,
    type: true,
    domain: true,
    source: true,
    origin: true,
    horizonDays: true,
  }).shape,
  at: at("offers"),
  cursor,
  limit,
});

export type OfferListQuery = z.output<typeof OfferListQuery>;

/** Query of the latest readings: filters, the canonical view, and the page (keyed by series). */
export const LatestObservationQuery = z.strictObject({
  bbox: bbox.optional(),
  property: list.describe("comma-separated property codes").optional(),
  domain: z.string().min(1).describe("only properties of this domain").optional(),
  source: list
    .describe(
      "comma-separated source ids; with canonical=1, @fused and @fused-public name fused readings as the request's scope reads them: the operator's @fused only, the public scope's @fused where every contributor is public and @fused-public otherwise",
    )
    .optional(),
  origin: list.describe("comma-separated origins: feed, crowd, federation, derived").optional(),
  at: at("readings"),
  since: z.iso
    .datetime({ offset: true })
    .describe(
      "only readings in effect from this instant on (their phenomenon started then or later)",
    )
    .optional(),
  canonical: canonical(
    "the canonical view: a feature's fused reading of each property several sources or the crowd may report (for the operator source @fused, fused from every source; in public scope fused from public sources only, source @fused when every contributor is public, else @fused-public), and the per-source readings of the rest; a place's readings, crowd ones included, as they are (nothing fuses a place)",
  ),
  cursor: z
    .string()
    .regex(/^\d+$/, "cursor is the `next` of the previous page")
    .describe("the `next` of the previous page: a series id")
    .optional(),
  limit,
});

export type LatestObservationQuery = z.output<typeof LatestObservationQuery>;

/** Query of a reading grid: one property, the box, the cell size and the instant readings start from. */
export const GridQuery = z
  .strictObject({
    property: z.string().min(1).describe("the property code; its numeric readings are aggregated"),
    bbox: bbox.describe(
      `west,south,east,north in WGS84 degrees; at most ${MAX_GRID_CELLS} cells of cellDeg`,
    ),
    cellDeg: z.coerce
      .number()
      .min(0.05)
      .max(5)
      .describe("the cell size in degrees; cells are aligned on its multiples from 0°"),
    since: z.iso
      .datetime({ offset: true })
      .describe(
        "only readings in effect from this instant on (their phenomenon started then or later)",
      ),
    source: list.describe("comma-separated source ids").optional(),
  })
  .superRefine((q, ctx) => {
    if (!Array.isArray(q.bbox) || !Number.isFinite(q.cellDeg)) return;
    if (gridCellCount(q.bbox, q.cellDeg) > MAX_GRID_CELLS) {
      ctx.addIssue({
        code: "custom",
        path: ["bbox"],
        message: `the box holds more than ${MAX_GRID_CELLS} cells; ask for a larger cellDeg`,
      });
    }
  });

export type GridQuery = z.output<typeof GridQuery>;

/** Query of one series: what names it, the range, the resolution and the page. */
export const SeriesQuery = z
  .strictObject({
    subject: z
      .string()
      .min(1)
      .describe(
        "the series' subject key (`feature:<id>`, `feature:<id>#<component>`, …) or a record id",
      ),
    component: z.string().min(1).describe("a component of the feature `subject` names").optional(),
    property: z.string().min(1).describe("the property code"),
    qualifiers: z
      .string()
      .describe("the series' qualifiers as a JSON object")
      .transform((value, ctx) => {
        try {
          const parsed: unknown = JSON.parse(value);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {}
        ctx.addIssue({ code: "custom", message: "qualifiers must be a JSON object" });
        return z.NEVER;
      })
      .optional(),
    source: z
      .string()
      .min(1)
      .describe("the source, where several report on one subject")
      .optional(),
    from: z.iso
      .datetime({ offset: true })
      .describe("start of the range; default a day before `to`")
      .optional(),
    to: z.iso
      .datetime({ offset: true })
      .describe("end of the range (exclusive); default now")
      .optional(),
    resolution: z
      .enum(["raw", "hourly", "daily"])
      .describe(
        "raw readings or rollups; default raw within the property's raw retention, its rollup beyond",
      )
      .optional(),
    cursor,
    limit,
  })
  .refine(
    (q) => q.from === undefined || q.to === undefined || Date.parse(q.from) < Date.parse(q.to),
    {
      message: "from must be before to",
      path: ["from"],
    },
  );

export type SeriesQuery = z.output<typeof SeriesQuery>;

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
