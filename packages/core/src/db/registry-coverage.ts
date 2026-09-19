import { assertRegistryCovers, type HeldCodes, type Registry } from "@openconditions/model";
import type postgres from "postgres";

/** The registry-governed codes stored rows hold: the wire formats they were read from. */
export async function storedRegistryCodes(sql: postgres.Sql): Promise<HeldCodes> {
  const rows = await sql<{ source_format: string }[]>`
    SELECT DISTINCT source_format FROM conditions.observations ORDER BY source_format`;
  return { sourceFormats: rows.map((r) => r.source_format) };
}

/**
 * The boot check every service runs after migrating: fail when the database
 * holds a code the running registry does not register, instead of serving or
 * federating rows no schema describes. The caller passes the assembled
 * production registry (core never imports it).
 */
export async function assertStoredCodesRegistered(
  sql: postgres.Sql,
  registry: Registry,
): Promise<void> {
  assertRegistryCovers(registry, await storedRegistryCodes(sql));
}
