import { createHash } from "node:crypto";
import { readCapXml } from "@openconditions/hazards";
import type { CatalogFeed } from "@openconditions/ingest-framework";
import type postgres from "postgres";

export interface SmnMessage {
  identifier: string;
  body: Buffer;
  retainUntil: string;
}
export interface SmnWindow {
  messages: SmnMessage[];
  baseline: string;
}
const fingerprint = (rows: readonly { identifier: string; body: Buffer }[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .map((r) => [r.identifier, createHash("sha256").update(r.body).digest("hex")])
          .sort((a, b) => a[0]!.localeCompare(b[0]!)),
      ),
    )
    .digest("hex");
const WINDOW = 7 * 86400000;

/** Merge the rolling bulletin with its durable window. No absence in RSS is withdrawal authority. */
export async function smnMessages(
  sql: postgres.Sql,
  feed: CatalogFeed,
  bodies: readonly Buffer[],
  now: string,
): Promise<SmnWindow> {
  const at = Date.parse(now);
  const rows = await sql<
    { identifier: string; body: Buffer; retain_until: Date }[]
  >`SELECT identifier, body, retain_until FROM conditions.smn_cap_message WHERE source_id=${feed.id} AND retain_until > ${now}::timestamptz ORDER BY identifier LIMIT 4097`;
  const messages = new Map(
    rows.map((r) => [
      r.identifier,
      {
        identifier: r.identifier,
        body: r.body,
        retainUntil: new Date(r.retain_until).toISOString(),
      },
    ]),
  );
  const seen = new Map<string, Buffer>();
  for (const body of bodies) {
    const alert = readCapXml(body, true);
    const duplicate = seen.get(alert.identifier);
    if (duplicate && !duplicate.equals(body))
      throw new Error("SMN: conflicting duplicate CAP identifier");
    seen.set(alert.identifier, body);
    const sent = Date.parse(alert.sent);
    if (!Number.isFinite(sent) || sent > at + 300000) throw new Error("SMN: invalid CAP sent");
    // Bound history, including cancels and non-public messages that can supersede public ones.
    const until = sent + WINDOW;
    for (const info of alert.info ?? []) {
      const expires = Date.parse(info.expires ?? "");
      if (!Number.isFinite(expires) || expires > until)
        throw new Error("SMN: CAP expiry outside qualified retention window");
    }
    if (until > at)
      messages.set(alert.identifier, {
        identifier: alert.identifier,
        body,
        retainUntil: new Date(until).toISOString(),
      });
  }
  if (
    messages.size > 4096 ||
    [...messages.values()].reduce((n, m) => n + m.body.length, 0) > 32 * 1024 * 1024
  )
    throw new Error("SMN: durable bulletin budget exceeded");
  return { messages: [...messages.values()], baseline: fingerprint(rows) };
}

/** Refuse a stale parse if another worker committed a message window while it parsed. */
export async function checkSmnWindow(
  tx: postgres.TransactionSql,
  sourceId: string,
  window: SmnWindow,
  now: string,
): Promise<void> {
  const rows = await tx<
    { identifier: string; body: Buffer }[]
  >`SELECT identifier, body FROM conditions.smn_cap_message WHERE source_id=${sourceId} AND retain_until > ${now}::timestamptz ORDER BY identifier`;
  if (fingerprint(rows) !== window.baseline)
    throw new Error("SMN: concurrent bulletin changed; retry next poll");
}

/** The message window and its projected snapshot must commit or roll back together. */
export async function storeSmnMessages(
  tx: postgres.TransactionSql,
  sourceId: string,
  messages: readonly SmnMessage[],
  now: string,
): Promise<void> {
  await tx`DELETE FROM conditions.smn_cap_message WHERE source_id=${sourceId} AND retain_until <= ${now}::timestamptz`;
  for (const message of messages)
    await tx`INSERT INTO conditions.smn_cap_message (source_id, identifier, body, retain_until) VALUES (${sourceId},${message.identifier},${message.body},${message.retainUntil}::timestamptz) ON CONFLICT (source_id,identifier) DO UPDATE SET body=excluded.body, retain_until=excluded.retain_until`;
}
