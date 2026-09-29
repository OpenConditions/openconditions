import { z } from "zod";
import type { Vocab } from "./vocab.js";

/** An instant with a zone designator (`Z` or `±hh:mm`), seconds required. */
export const Iso8601 = z.iso.datetime({ offset: true });
export const Bcp47 = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/);
/** UCUM unit code; which unit is allowed is decided per property or field, never here. */
export const UcumUnit = z.string().min(1).max(32);
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);
/** Decimal amount as a string, so money never passes through a float. */
export const DecimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const LocalizedText = z.strictObject({
  lang: Bcp47,
  text: z.string().min(1),
  machine: z.literal(true).optional(),
});
/** Localised text; the first entry is the source's primary language. */
export const Text = z.array(LocalizedText).min(1);

export const Quantity = z.strictObject({
  value: z.number(),
  unit: UcumUnit,
  accuracy: z.number().nonnegative().optional(),
});
/** A quantity held to one canonical unit: a field that is always metres accepts nothing else. */
export const quantityIn = <const U extends string>(unit: U) =>
  z.strictObject({
    value: z.number().nonnegative(),
    unit: z.literal(unit),
    accuracy: z.number().nonnegative().optional(),
  });
export const Money = z.strictObject({ amount: DecimalString, currency: CurrencyCode });

/** A day of the year without a year, `MM-DD`. */
export const MonthDay = z.string().regex(/^(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/);
/**
 * A recurring stretch of the year, both days included (a pass closed from
 * 12-01 to 05-01). It wraps the new year when `from` is later than `to`.
 */
export const SeasonalWindow = z.strictObject({ from: MonthDay, to: MonthDay });
export type SeasonalWindow = z.infer<typeof SeasonalWindow>;

/** Whether a local date (`YYYY-MM-DD`, in the place's own zone) lies inside a seasonal window. */
export function inSeasonalWindow(window: SeasonalWindow, localDate: string): boolean {
  const day = localDate.slice(5, 10);
  return window.from <= window.to
    ? day >= window.from && day <= window.to
    : day >= window.from || day <= window.to;
}

export const RECORD_CLASSES = ["feature", "situation", "observation", "offer"] as const;
export const RecordClass = z.enum(RECORD_CLASSES);
export const RecordRef = z.strictObject({
  class: RecordClass,
  id: z.string().min(1),
  componentKey: z.string().min(1).optional(),
});

export const ORGANIZATION_ROLES = [
  "operator",
  "owner",
  "suboperator",
  "publisher",
  "cpo",
  "emsp",
  "authority",
] as const;

const Longitude = z.number().min(-180).max(180);
const Latitude = z.number().min(-90).max(90);
export const Position = z.union([
  z.tuple([Longitude, Latitude]),
  z.tuple([Longitude, Latitude, z.number()]),
]);
const LineCoordinates = z.array(Position).min(2);
const Ring = z
  .array(Position)
  .min(4)
  .refine((ring) => ring[0]!.every((value, i) => value === ring[ring.length - 1]![i]), {
    message: "a polygon ring must be closed",
  });
const PolygonCoordinates = z.array(Ring).min(1);

export const PointGeometry = z.strictObject({ type: z.literal("Point"), coordinates: Position });
export const MultiPointGeometry = z.strictObject({
  type: z.literal("MultiPoint"),
  coordinates: z.array(Position).min(1),
});
export const LineStringGeometry = z.strictObject({
  type: z.literal("LineString"),
  coordinates: LineCoordinates,
});
export const MultiLineStringGeometry = z.strictObject({
  type: z.literal("MultiLineString"),
  coordinates: z.array(LineCoordinates).min(1),
});
export const PolygonGeometry = z.strictObject({
  type: z.literal("Polygon"),
  coordinates: PolygonCoordinates,
});
export const MultiPolygonGeometry = z.strictObject({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(PolygonCoordinates).min(1),
});
const SimpleGeometry = z.discriminatedUnion("type", [
  PointGeometry,
  MultiPointGeometry,
  LineStringGeometry,
  MultiLineStringGeometry,
  PolygonGeometry,
  MultiPolygonGeometry,
]);
/** RFC 7946 geometry; a GeometryCollection holds simple geometries only (no nesting). */
export const Geometry = z.union([
  SimpleGeometry,
  z.strictObject({ type: z.literal("GeometryCollection"), geometries: z.array(SimpleGeometry) }),
]);

/** Value objects that reference registry-extensible vocabularies. */
export function valueObjectSchemas(vocab: Vocab) {
  const ExternalId = z.strictObject({
    scheme: vocab("external_id_scheme"),
    id: z.string().min(1),
    authority: z.string().min(1).optional(),
  });
  const Organization = z.strictObject({
    role: z.enum(ORGANIZATION_ROLES),
    name: Text,
    ids: z.array(ExternalId).min(1).optional(),
    website: z.url().optional(),
    phone: z.string().min(1).optional(),
    email: z.email().optional(),
  });
  const Address = z.strictObject({
    street: z.string().min(1).optional(),
    houseNumber: z.string().min(1).optional(),
    postalCode: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    country: CountryCode,
    text: z.string().min(1).optional(),
  });
  return { ExternalId, Organization, Address };
}

export type LocalizedText = z.infer<typeof LocalizedText>;
export type Text = z.infer<typeof Text>;
export type Quantity = z.infer<typeof Quantity>;
export type Money = z.infer<typeof Money>;
export type RecordClass = z.infer<typeof RecordClass>;
export type RecordRef = z.infer<typeof RecordRef>;
export type Geometry = z.infer<typeof Geometry>;
export type PointGeometry = z.infer<typeof PointGeometry>;
