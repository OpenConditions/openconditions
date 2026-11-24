import { type SQL, sql } from "drizzle-orm";
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

/** Raw bytes column (public keys, signatures, sealed secrets). */
export const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * The CHECK of a secret stored AES-256-GCM sealed in `<column>_ciphertext`,
 * `<column>_iv` and `<column>_tag`: the three are stored together (or, in
 * nullable columns, all left null), with a 12-byte IV and a 16-byte tag.
 */
export function sealedSecretCheck(column: string): SQL {
  const [c, iv, tag] = ["ciphertext", "iv", "tag"].map((part) => `"${column}_${part}"`);
  return sql.raw(
    `(${c} IS NULL) = (${iv} IS NULL) AND (${iv} IS NULL) = (${tag} IS NULL) AND octet_length(${iv}) = 12 AND octet_length(${tag}) = 16`,
  );
}

/** 64-bit transaction id (`xid8`) — the epoch-safe full transaction id used to
 * fence the federation outbox cursor against not-yet-committed lower seqs. */
export const xid8 = customType<{ data: string }>({
  dataType() {
    return "xid8";
  },
});
