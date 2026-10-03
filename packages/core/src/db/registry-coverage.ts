import { assertRegistryCovers, type HeldCodes, type Registry } from "@openconditions/model";
import type postgres from "postgres";

/**
 * The registry-governed codes stored rows hold: the wire formats of the
 * loaded sources (a source no longer loaded keeps its row, inactive, and
 * nothing reads its format), the kinds of every class table and component, and the
 * properties of every observation series.
 */
export async function storedRegistryCodes(sql: postgres.Sql): Promise<HeldCodes> {
  const formats = await sql<{ format: string }[]>`
    SELECT DISTINCT format FROM conditions.source WHERE active ORDER BY format`;
  const kinds = await sql<
    { class: "feature" | "component" | "situation" | "offer"; code: string }[]
  >`
    SELECT 'situation' AS class, kind AS code FROM conditions.situation
    UNION SELECT 'feature', kind FROM conditions.feature
    UNION SELECT 'component', kind FROM conditions.feature_component
    UNION SELECT 'offer', kind FROM conditions.offer
    ORDER BY class, code`;
  const properties = await sql<{ property: string }[]>`
    SELECT DISTINCT property FROM conditions.observation_latest ORDER BY property`;
  return {
    sourceFormats: formats.map((r) => r.format),
    kinds: kinds.map((r) => ({ class: r.class, code: r.code })),
    properties: properties.map((r) => r.property),
  };
}

/**
 * The boot check every service runs after migrating: fail when the database
 * holds a code the running registry does not register, instead of serving or
 * federating rows no schema describes. The caller passes the assembled
 * production registry (core never imports it).
 *
 * A service that reads no feed passes `sourceFormats: false`: the loaded
 * sources are ingest's to sync, and a release that retires a format would
 * otherwise fail such a service's boot until ingest had marked the source
 * inactive, though it never reads that format.
 */
export async function assertStoredCodesRegistered(
  sql: postgres.Sql,
  registry: Registry,
  opts: { sourceFormats?: boolean } = {},
): Promise<void> {
  const held = await storedRegistryCodes(sql);
  assertRegistryCovers(
    registry,
    opts.sourceFormats === false ? { ...held, sourceFormats: [] } : held,
  );
}
