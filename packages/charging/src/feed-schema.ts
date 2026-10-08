import {
  type CatalogFeed,
  feedBaseShape,
  fieldRef,
  layoutBlockSchema,
  mapped,
  regexSource,
} from "@openconditions/ingest-framework";
import { AUDIENCES, LIFECYCLES } from "@openconditions/model";
import {
  CHARGING_PARKING_TYPES,
  CONNECTOR_POWER_TYPES,
  CONNECTOR_STANDARDS,
} from "@openconditions/model-charging";
import { z } from "zod";

const CURRENTS = ["ac", "dc"] as const;
const FORMATS = ["socket", "cable"] as const;

const standard = z.enum(CONNECTOR_STANDARDS);

/**
 * One connector per record. Without a `standard` map the field holds OCPI
 * `ConnectorType` codes; without a `standard` rule at all the plug is
 * `UNKNOWN`. A bare power is in `unit`. A `count` above one makes the
 * record's charge point stand for that many.
 */
const rowConnectors = z.strictObject({
  standard: z
    .strictObject({ field: fieldRef, map: z.record(z.string(), standard).optional() })
    .optional(),
  format: z.union([mapped(FORMATS), z.enum(FORMATS)]).optional(),
  current: mapped(CURRENTS).optional(),
  powerType: mapped(CONNECTOR_POWER_TYPES).optional(),
  powerKw: z
    .strictObject({
      field: z.string().min(1),
      unit: z.enum(["kW", "W"]),
      pattern: regexSource.optional(),
    })
    .optional(),
  count: fieldRef.optional(),
});

/** A count column per kind of charge point, each count above zero one charge point group. */
const columnConnectors = z
  .array(
    z.strictObject({
      count: fieldRef,
      standard,
      current: z.enum(CURRENTS).optional(),
      format: z.enum(FORMATS).optional(),
      powerKw: z.number().positive().optional(),
    }),
  )
  .min(1);

/**
 * A text split on the `separator` regular expression into parts that must
 * match `pattern`; a part that does not match names nothing. The pattern's
 * named groups `count`, `type` and `power` (a power with its unit, a bare one
 * in kW) are read.
 */
const listShape = { field: fieldRef, separator: regexSource, pattern: regexSource };

/**
 * A text listing what a record's charging offers. With `as: "evses"` (the
 * default) each part is a group of `count` identical charge points with one
 * connector. With `as: "connectors"` each part is one connector type of every
 * charge point, its count unread (a site's plug total says nothing per charge
 * point); the charge points are the `groups` text's parts (`count` and
 * `power` read), else one charge point.
 */
const listConnectors = z
  .strictObject({
    ...listShape,
    as: z.enum(["evses", "connectors"]).optional(),
    map: z
      .record(
        z.string(),
        z.strictObject({
          standard,
          current: z.enum(CURRENTS).optional(),
          format: z.enum(FORMATS).optional(),
        }),
      )
      .optional(),
    current: mapped(CURRENTS).optional(),
    groups: z.strictObject(listShape).optional(),
  })
  .refine((list) => list.groups === undefined || list.as === "connectors", {
    path: ["groups"],
    message: 'groups apply to as: "connectors" only',
  });

/**
 * How a layout feed's records become charging sites. Records sharing an id
 * form one site, whose own fields come from the first. Every value is read
 * through a `FieldRef`; value maps hold the closed vocabularies, so the
 * catalogue's JSON Schema lists them.
 */
export const chargingMappingSchema = z.strictObject({
  /** The site id; several fields make a composite id, joined with `,`. */
  id: z.union([fieldRef, z.array(fieldRef).min(2)]),
  /** Name candidates; the first non-empty one wins. */
  name: z.array(fieldRef).min(1).optional(),
  /** The language of the source's texts (BCP 47). */
  lang: z.string().min(2).optional(),
  operator: fieldRef.optional(),
  website: fieldRef.optional(),
  address: z
    .strictObject({
      street: fieldRef.optional(),
      houseNumber: fieldRef.optional(),
      postalCode: fieldRef.optional(),
      city: fieldRef.optional(),
      text: fieldRef.optional(),
    })
    .optional(),
  openingHours: z.strictObject({ field: fieldRef, syntax: z.enum(["osm", "text"]) }).optional(),
  audience: mapped(AUDIENCES).optional(),
  lifecycle: mapped(LIFECYCLES).optional(),
  /**
   * When building is to finish: a site whose date lies after the fetch is
   * planned. Read are `31/07/2023` (day first), `30 November 2023` and
   * `November 2023` (the month's end); any other text says nothing.
   */
  completion: fieldRef.optional(),
  parkingType: mapped(CHARGING_PARKING_TYPES).optional(),
  tariffText: fieldRef.optional(),
  notes: fieldRef.optional(),
  /**
   * Which records are one charge point: those sharing `key`, with its eMI3 id
   * from `evseId`. Without it, each connector entry is its own charge point.
   */
  evse: z.strictObject({ key: fieldRef.optional(), evseId: fieldRef.optional() }).optional(),
  /** How a record names its connectors: exactly one of `row`, `columns` and `list`. */
  connectors: z.union([
    z.strictObject({ row: rowConnectors }),
    z.strictObject({ columns: columnConnectors }),
    z.strictObject({ list: listConnectors }),
  ]),
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

export type ChargingMapping = z.infer<typeof chargingMappingSchema>;

/**
 * The fields a charging feed adds to the base feed: for the generic layouts
 * (`geojson`, `json`, `csv`), how the payload is cut into records and how
 * records become sites.
 */
const chargingFeedExtension = {
  layout: layoutBlockSchema.optional(),
  charging: chargingMappingSchema.optional(),
} as const;

export type ChargingFeedExtension = z.infer<z.ZodObject<typeof chargingFeedExtension>>;

/**
 * Raw per-field shape of a charging feed: the base shape plus the charging
 * fields. The catalogue builds `.strict()` region-file schemas from it.
 */
export const chargingFeedShape = { ...feedBaseShape, ...chargingFeedExtension } as const;

/** A loaded charging feed: the catalogue feed plus the charging fields. */
export type ChargingCatalogFeed = CatalogFeed & ChargingFeedExtension;
