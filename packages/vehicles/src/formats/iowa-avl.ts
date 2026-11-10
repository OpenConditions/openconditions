import {
  emptyParseOutput,
  type FeedPayloads,
  type ParseContext,
  type ParseOutput,
  recordSkipped,
} from "@openconditions/ingest-framework";
import type { VehiclesCatalogFeed } from "../feed-schema.js";
import {
  isRecord,
  jsonOf,
  lonLat,
  pointLocation,
  provenance,
  utcInstant,
  withObservationId,
} from "../records.js";

const AGENCY = "Iowa Department of Transportation - Office of Maintenance";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Selected moving trucks, not a fleet snapshot. Only the UTC ping dates a position. */
export function parseIowaAvl(
  feed: VehiclesCatalogFeed,
  payloads: FeedPayloads,
  ctx: ParseContext,
): ParseOutput {
  const out = emptyParseOutput();
  const labels = new Set<string>();
  const rows = new Set<number>();
  const fetched = Date.parse(ctx.fetchedAt);
  for (const body of payloads["main"] ?? []) {
    const doc = jsonOf(body, "Iowa AVL");
    if (!isRecord(doc) || doc["error"] !== undefined || !Array.isArray(doc["features"]))
      throw new Error("Iowa AVL: invalid feature set");
    const sr = doc["spatialReference"];
    if (doc["features"].length === 0 && sr === undefined) continue;
    if (
      !isRecord(sr) ||
      sr["wkid"] !== 4326 ||
      (sr["latestWkid"] !== undefined && sr["latestWkid"] !== 4326)
    )
      throw new Error("Iowa AVL: expected WGS84");
    for (const feature of doc["features"]) {
      if (!isRecord(feature) || !isRecord(feature["attributes"]) || !isRecord(feature["geometry"]))
        throw new Error("Iowa AVL: malformed row");
      const a = feature["attributes"];
      const label = a["LABEL"];
      const row = a["OBJECTID"];
      if (
        typeof label !== "string" ||
        !label ||
        label.trim() !== label ||
        labels.has(label) ||
        !Number.isSafeInteger(row) ||
        rows.has(row as number)
      )
        throw new Error("Iowa AVL: missing or ambiguous identity");
      labels.add(label);
      rows.add(row as number);
      const g = feature["geometry"];
      const point = lonLat([g["x"], g["y"]]);
      if (!point || point[0] < -96.7 || point[0] > -90 || point[1] < 40.3 || point[1] > 43.6)
        throw new Error("Iowa AVL: position outside Iowa/WGS84");
      if (
        g["spatialReference"] !== undefined &&
        (!isRecord(g["spatialReference"]) || g["spatialReference"]["wkid"] !== 4326)
      )
        throw new Error("Iowa AVL: projected geometry");
      const ping = a["MODIFIEDDT"];
      // Never let the canonical helper's future-clock clamp turn a bad ping into a fresh one.
      if (!finite(ping) || !Number.isSafeInteger(ping) || ping <= 0 || ping > fetched) {
        recordSkipped(feed.id, "malformed");
        continue;
      }
      if (fetched - ping >= 600000) continue;
      const id = `oc:feature:${feed.id}:${encodeURIComponent(label)}`;
      const prov = provenance(feed, label);
      out.features.push({
        id,
        class: "feature",
        kind: "service_vehicle",
        type: "snowplow",
        temporality: "static",
        lifecycle: "operational",
        location: {
          geometry: null,
          extent: "none",
          geometryOrigin: "none",
          fuzziness: "exact",
          admin: { country: "US", subdivision: "US-IA" },
        },
        provenance: prov,
        freshness: { fetchedAt: ctx.fetchedAt },
        details: { kind: "service_vehicle", v: 1, fleetId: label, agency: AGENCY },
      });
      const heading = a["HEADING"],
        speed = a["VELOCITY"],
        route = a["ROUTE_NAME"],
        material = a["ACTIVE_MATERIAL"];
      const spreader =
        material === "NONE"
          ? false
          : ["SOLID", "LIQUID", "LIQUID_SOLID"].includes(material as string)
            ? true
            : undefined;
      out.observations.push(
        withObservationId(feed, {
          class: "observation",
          kind: "observation",
          property: "vehicle.position",
          temporality: "live",
          subject: { kind: "feature", featureId: id },
          location: pointLocation(point),
          provenance: prov,
          freshness: { fetchedAt: ctx.fetchedAt, expiresAt: utcInstant(new Date(ping + 600000)) },
          phenomenonTime: { instant: utcInstant(new Date(ping)) },
          aggregation: "instantaneous",
          result: {
            type: "structured",
            schema: "vehicle_position",
            v: 1,
            value: {
              v: 1,
              point: { type: "Point", coordinates: point },
              ...(finite(heading) && heading >= 0 && heading <= 360
                ? { bearingDeg: heading % 360 }
                : {}),
              ...(finite(speed) && speed >= 0
                ? { speed: { value: speed * 1.609344, unit: "km/h" } }
                : {}),
              ...(typeof route === "string" && route.trim() ? { routeName: route.trim() } : {}),
              ...(spreader === undefined ? {} : { spreaderOn: spreader }),
            },
          },
        }),
      );
    }
  }
  return out;
}
