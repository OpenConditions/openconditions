import { customType, pgSchema, timestamp } from "drizzle-orm/pg-core";

/** The service's Postgres schema; every OpenConditions table lives in it. */
export const conditionsSchema = pgSchema("conditions");

/** A `timestamp with time zone` column. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** PostGIS geometry column. Requires the `postgis` extension (created by the
 * first migration, which drizzle-kit cannot model on its own). */
export const geometry = customType<{ data: string }>({
  dataType() {
    return "geometry(Geometry, 4326)";
  },
});

/** PostGIS Point geometry column (crowd sub-claims are always single points). */
export const geometryPoint = customType<{ data: string }>({
  dataType() {
    return "geometry(Point, 4326)";
  },
});

/** Raw bytes column (issuer signing keypair material). */
export const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/** 64-bit transaction id (`xid8`) — the epoch-safe full transaction id used to
 * fence the federation outbox cursor against not-yet-committed lower seqs. */
export const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});
