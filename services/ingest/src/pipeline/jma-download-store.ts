import type postgres from "postgres";
import { JMA_DAILY_BYTES, type JmaDownload, type JmaDownloadStore } from "./jma-acquisition.js";

/** One database and one egress key must cover every worker sharing the provider-visible IP. */
export function jmaDownloadStore(sql: postgres.Sql): JmaDownloadStore {
  return {
    async withUrl(url, action) {
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`jma-download:${url}`}, 0))`;
        const [held] = await tx<
          { value: JmaDownload }[]
        >`SELECT value FROM conditions.jma_download WHERE url = ${url}`;
        return action(held?.value, async (value) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended('jma-cache-capacity', 0))`;
          const [{ count }] = await tx<
            { count: number }[]
          >`SELECT count(*)::int AS count FROM conditions.jma_download`;
          if (!held && count >= 25000)
            throw new Error("JMA: download-cache entry ceiling; retaining last good state");
          await tx`INSERT INTO conditions.jma_download (url, value) VALUES (${url}, ${tx.json(value as unknown as postgres.JSONValue)})
            ON CONFLICT (url) DO UPDATE SET value = EXCLUDED.value`;
        });
      }) as ReturnType<typeof action>;
    },
    async reserve(egress, day, cap) {
      // Old uncertainty consumes its original UTC day only. Never refund it into
      // today's allowance. Retain eight daily receipts and 45 days of bodies.
      const floor = Date.parse(`${day}T00:00:00Z`) - 45 * 86_400_000;
      await sql`DELETE FROM conditions.jma_download WHERE (value->>'checkedAt')::bigint < ${floor}`;
      const budgetFloor = new Date(Date.parse(`${day}T00:00:00Z`) - 8 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await sql`DELETE FROM conditions.jma_budget WHERE day < ${budgetFloor}`;
      await sql`INSERT INTO conditions.jma_budget (egress, day) VALUES (${egress}, ${day}) ON CONFLICT DO NOTHING`;
      const rows = await sql`UPDATE conditions.jma_budget SET reserved = reserved + ${cap}
        WHERE egress = ${egress} AND day = ${day} AND used + reserved + ${cap} <= ${JMA_DAILY_BYTES}
        RETURNING egress`;
      if (!rows.length)
        throw new Error(
          "JMA: daily budget unavailable (received bytes plus outstanding reservations)",
        );
    },
    async settle(egress, day, cap, received) {
      await sql`UPDATE conditions.jma_budget SET reserved = reserved - ${cap}, used = used + ${received}
        WHERE egress = ${egress} AND day = ${day}`;
    },
  };
}
