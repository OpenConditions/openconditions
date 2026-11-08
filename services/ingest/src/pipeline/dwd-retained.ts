import type { FeedPayloads, ParseOutput } from "@openconditions/ingest-framework";
import { DWD_PRODUCTS, DWD_ROLES, dwdSites } from "@openconditions/weather";
import type postgres from "postgres";

/** Reject incomplete DWD transitions rather than changing the rights or subject of retained readings. */
export async function checkDwdRetained(
  sql: postgres.TransactionSql,
  sourceId: string,
  payloads: FeedPayloads,
  parsed: Pick<ParseOutput, "observations">,
  at: string,
): Promise<void> {
  const metadata = new Map(
    DWD_ROLES.map((role) => {
      const body = payloads[`${role}_stations`]?.[0];
      if (!body) throw new Error(`DWD missing ${role} metadata for retained observations`);
      return [role, dwdSites(body)] as const;
    }),
  );
  const restricted = new Set(
    [...metadata.values()].flatMap((sites) =>
      [...sites.values()].filter((site) => !site.free).map((site) => site.id),
    ),
  );
  const restatedRestricted = new Set(
    parsed.observations
      .filter((draft) => (draft.provenance as { upstream?: unknown[] }).upstream?.length)
      .map((draft) => draft.id),
  );
  const retained = await sql<{ id: string; station: string; component: string }[]>`
    SELECT record->>'id' AS id,
           record #>> '{provenance,recordId}' AS station,
           record #>> '{subject,componentKey}' AS component
      FROM (
        SELECT conditions.observation_record(l.template, l.reading) AS record
          FROM conditions.observation_latest l
         WHERE l.source_id = ${sourceId}
           AND (l.expires_at IS NULL OR l.expires_at > ${at}::timestamptz)
      ) live`;
  const day = at.slice(0, 10);
  for (const reading of retained) {
    const role = DWD_ROLES.find((role) =>
      Object.hasOwn(DWD_PRODUCTS[role].fields, reading.component),
    );
    const site = role === undefined ? undefined : metadata.get(role)?.get(reading.station);
    if (
      !site ||
      day < site.from ||
      day > site.until ||
      (restricted.has(reading.station) && !restatedRestricted.has(reading.id))
    )
      throw new Error(
        "DWD incoherent retained observation — refusing metadata transition; keeping last-good publication until source expiry",
      );
  }
}
