import {
  type CatalogFeed,
  feedBaseShape,
  fieldRef,
  layoutBlockSchema,
  mapped,
} from "@openconditions/ingest-framework";
import { Quantity } from "@openconditions/model";
import {
  PARKING_LAYOUTS,
  PARKING_SITE_TYPES,
  PARKING_STATUSES,
  PARKING_USER_GROUPS,
  PARKING_VEHICLE_TYPES,
} from "@openconditions/model-parking";
import { z } from "zod";

/** A source value: what `equals` and the value maps compare against. */
const scalar = z.union([z.string(), z.number(), z.boolean()]);

/** Holds when the field's value, as text, is the given one. */
const condition = z.strictObject({ field: fieldRef, equals: scalar });

const TRENDS = ["filling", "clearing", "steady"] as const;

const statusRule = mapped(PARKING_STATUSES);

/**
 * How a layout feed's records become parking sites and readings. Every value
 * is read through a `FieldRef`; value maps hold the closed vocabularies, so the
 * catalogue's JSON Schema lists them.
 */
export const parkingMappingSchema = z.strictObject({
  id: fieldRef,
  /** Name candidates; the first non-empty one wins. */
  name: z.array(fieldRef).min(1).optional(),
  /** The language of the source's texts (BCP 47). */
  lang: z.string().min(2).optional(),
  type: mapped(PARKING_SITE_TYPES).optional(),
  defaultType: z.enum(PARKING_SITE_TYPES).optional(),
  layout: mapped(PARKING_LAYOUTS).optional(),
  defaultLayout: z.enum(PARKING_LAYOUTS).optional(),
  capacity: fieldRef.optional(),
  available: fieldRef.optional(),
  occupied: fieldRef.optional(),
  /** A status rule, or several: the first whose value maps wins. */
  status: z.union([statusRule, z.array(statusRule).min(1)]).optional(),
  trend: mapped(TRENDS).optional(),
  /**
   * When the counts were measured: ISO 8601 (default) or `d.m.y h:m`.
   * `timezone` (IANA) is always required: it reads a `d.m.y h:m` time and an
   * ISO time without an offset, and a feed cannot promise that every value
   * carries one; an ISO time with an offset is taken as given. A record whose
   * time is missing or unreadable gives no reading. Without `updated` the
   * readings take the poll's time.
   */
  updated: z
    .strictObject({
      field: fieldRef,
      format: z.enum(["iso", "d.m.y h:m"]).optional(),
      timezone: z.string().min(1),
    })
    .optional(),
  /** Readings only when this holds. */
  liveWhen: condition.optional(),
  address: z
    .strictObject({
      street: fieldRef.optional(),
      houseNumber: fieldRef.optional(),
      postalCode: fieldRef.optional(),
      city: fieldRef.optional(),
      text: fieldRef.optional(),
    })
    .optional(),
  operator: fieldRef.optional(),
  website: fieldRef.optional(),
  openingHours: z.strictObject({ field: fieldRef, syntax: z.enum(["osm", "text"]) }).optional(),
  tariffText: fieldRef.optional(),
  notes: fieldRef.optional(),
  /** Parking is free of charge when this holds. */
  free: condition.optional(),
  heightLimit: z.strictObject({ field: fieldRef, unit: z.enum(["m", "cm"]) }).optional(),
  /**
   * The site's areas. An area with a `capacity` field is there when the count
   * is above zero; one with `presentWhen` when that holds, its count optional.
   */
  areas: z
    .array(
      z.strictObject({
        vehicleType: z.enum(PARKING_VEHICLE_TYPES),
        userGroup: z.enum(PARKING_USER_GROUPS),
        capacity: fieldRef.optional(),
        presentWhen: condition.optional(),
      }),
    )
    .min(1)
    .optional(),
  /** Priced rows of one `parking_rate` offer, each a flat price. */
  rates: z
    .strictObject({
      currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code"),
      rows: z
        .array(
          z.strictObject({
            field: fieldRef,
            maxDuration: Quantity.optional(),
            userGroups: z.array(z.string().min(1)).min(1).optional(),
          }),
        )
        .min(1),
    })
    .optional(),
  /** Records kept: every filter holds (value among `include`, not among `exclude`). */
  filter: z
    .array(
      z.strictObject({
        field: fieldRef,
        include: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .optional(),
        exclude: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .optional(),
      }),
    )
    .min(1)
    .optional(),
});

export type ParkingMapping = z.infer<typeof parkingMappingSchema>;

/**
 * The fields a parking feed adds to the base feed: for the generic layouts
 * (`geojson`, `json`, `csv`), how the payload is cut into records and how a
 * record becomes a site.
 */
const parkingFeedExtension = {
  layout: layoutBlockSchema.optional(),
  parking: parkingMappingSchema.optional(),
} as const;

export type ParkingFeedExtension = z.infer<z.ZodObject<typeof parkingFeedExtension>>;

/**
 * Raw per-field shape of a parking feed: the base shape plus the parking
 * fields. The catalogue builds `.strict()` region-file schemas from it.
 */
export const parkingFeedShape = { ...feedBaseShape, ...parkingFeedExtension } as const;

/** A loaded parking feed: the catalogue feed plus the parking fields. */
export type ParkingCatalogFeed = CatalogFeed & ParkingFeedExtension;
