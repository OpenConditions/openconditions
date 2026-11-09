import { createHash } from "node:crypto";
import { readCapXml } from "@openconditions/hazards";
import type { CatalogFeed } from "@openconditions/ingest-framework";
import type postgres from "postgres";

export interface SmnMessage {
  identifier: string;
  body: Buffer;
  retrieval: unknown;
  retainUntil: string;
}
export interface SmnWindow {
  messages: SmnMessage[];
  parseBodies: Buffer[];
  baseline: string;
  decisionVersion: string;
}
const fingerprint = (
  rows: readonly { identifier: string; body: Buffer; retain_until: Date; retrieval: unknown }[],
) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .map((r) => [
            r.identifier,
            createHash("sha256").update(r.body).digest("hex"),
            new Date(r.retain_until).toISOString(),
            r.retrieval,
          ])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
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
  fetchId?: number,
  retrieval: readonly {
    sha256: string;
    url: string;
    headers: Record<string, string>;
    changed: boolean;
  }[] = [],
): Promise<SmnWindow> {
  const at = Date.parse(now);
  const rows = await sql<
    { identifier: string; body: Buffer; retrieval: unknown; retain_until: Date }[]
  >`SELECT identifier, body, retrieval, retain_until FROM conditions.smn_cap_message WHERE source_id=${feed.id} AND retain_until > ${now}::timestamptz ORDER BY identifier LIMIT 4097`;
  const decision = await sql<
    { version: string }[]
  >`SELECT xmin::text AS version FROM conditions.smn_cap_decision WHERE source_id=${feed.id}`;
  const messages = new Map(
    rows.map((r) => [
      createHash("sha256").update(r.body).digest("hex"),
      {
        identifier: r.identifier,
        body: r.body,
        retrieval: r.retrieval,
        retainUntil: new Date(r.retain_until).toISOString(),
      },
    ]),
  );
  for (const body of bodies) {
    const alert = readCapXml(body, true);
    const digest = createHash("sha256").update(body).digest("hex");
    const sent = Date.parse(alert.sent);
    if (!Number.isFinite(sent) || sent > at + 300000) throw new Error("SMN: invalid CAP sent");
    // Bound history, including cancels and non-public messages that can supersede public ones.
    const until = sent + WINDOW;
    for (const info of alert.info ?? []) {
      const expires = Date.parse(info.expires ?? "");
      if (!Number.isFinite(expires) || expires > until)
        throw new Error("SMN: CAP expiry outside qualified retention window");
    }
    if (until > at && !messages.has(digest))
      messages.set(digest, {
        identifier: alert.identifier,
        body,
        retrieval: { fetchedAt: now, sha256: digest, source: feed.id, fetchId },
        retainUntil: new Date(until).toISOString(),
      });
  }
  for (const [digest, message] of messages) {
    const claims = retrieval
      .filter((r) => r.sha256 === digest)
      .map((r) => ({ ...r, fetchedAt: now, fetchId }));
    if (!claims.length) continue;
    const prior = message.retrieval as Record<string, unknown>;
    const captures = Array.isArray(prior["captures"]) ? prior["captures"] : [];
    message.retrieval = { ...prior, captures: [...captures, ...claims] };
  }
  if (
    messages.size > 4096 ||
    [...messages.values()].reduce(
      (n, m) => n + m.body.length + Buffer.byteLength(JSON.stringify(m.retrieval)),
      0,
    ) >
      32 * 1024 * 1024
  )
    throw new Error("SMN: durable bulletin budget exceeded");
  const parseBodies = new Map(
    [...messages.values()].map((m) => [createHash("sha256").update(m.body).digest("hex"), m.body]),
  );
  for (const body of bodies) parseBodies.set(createHash("sha256").update(body).digest("hex"), body);
  if (
    parseBodies.size > 4096 ||
    [...parseBodies.values()].reduce((n, b) => n + b.length, 0) > 32 * 1024 * 1024
  )
    throw new Error("SMN: parse bulletin budget exceeded");
  return {
    messages: [...messages.values()],
    parseBodies: [...parseBodies.values()],
    baseline: fingerprint(rows),
    decisionVersion: decision[0]?.version ?? "absent",
  };
}

/** Refuse a stale parse if another worker committed a message window while it parsed. */
export async function checkSmnWindow(
  tx: postgres.TransactionSql,
  sourceId: string,
  window: SmnWindow,
  now: string,
): Promise<void> {
  const rows = await tx<
    { identifier: string; body: Buffer; retain_until: Date; retrieval: unknown }[]
  >`SELECT identifier, body, retain_until, retrieval FROM conditions.smn_cap_message WHERE source_id=${sourceId} AND retain_until > ${now}::timestamptz ORDER BY identifier`;
  const decision = await tx<
    { version: string }[]
  >`SELECT xmin::text AS version FROM conditions.smn_cap_decision WHERE source_id=${sourceId}`;
  if (
    fingerprint(rows) !== window.baseline ||
    (decision[0]?.version ?? "absent") !== window.decisionVersion
  )
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
    await tx`INSERT INTO conditions.smn_cap_message (source_id, identifier, body, retrieval, retain_until) VALUES (${sourceId},${message.identifier},${message.body},${tx.json(message.retrieval as postgres.JSONValue)},${message.retainUntil}::timestamptz) ON CONFLICT (source_id,variant) DO UPDATE SET retrieval=excluded.retrieval`;
}
