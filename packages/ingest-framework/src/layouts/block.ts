import { z } from "zod";

/**
 * How a feed's payload is cut into records and where each record sits. One
 * block serves the `geojson`, `json` and `csv` layouts; each layout reads the
 * members that apply to it.
 */
export const layoutBlockSchema = z.strictObject({
  records: z.string().min(1).optional(),
  lon: z.string().min(1).optional(),
  lat: z.string().min(1).optional(),
  point: z
    .strictObject({ field: z.string().min(1), order: z.enum(["lonlat", "latlon"]) })
    .optional(),
  geometryPath: z.string().min(1).optional(),
  crs: z
    .string()
    .regex(/^EPSG:\d{4,6}$/)
    .optional(),
  delimiter: z.string().length(1).optional(),
  encoding: z.enum(["utf-8", "latin1"]).optional(),
  decimalComma: z.boolean().optional(),
});

export type LayoutBlock = z.infer<typeof layoutBlockSchema>;
