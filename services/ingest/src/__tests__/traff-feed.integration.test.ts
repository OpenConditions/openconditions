import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { registry, situationDraft, writeSituations } from "./helpers/situations.js";

let db: TestDatabase;
let sql: postgres.Sql;
let app: ReturnType<typeof Fastify>;
const AT = "at=2026-09-06T10:00:00Z";
const TOKEN = "traff-operator-token-01234567890123456789";

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  app = Fastify();
  registerScope(app, TOKEN);
  registerApiRoutes(app, sql, { registry });
  await app.ready();
});
afterAll(async () => {
  await app?.close();
  await db?.close();
});
beforeEach(async () => {
  await sql`TRUNCATE conditions.situation CASCADE`;
});

/** Copy a validated stored record to exercise large reads without thousands of ingest writes. */
async function seed(count: number) {
  await writeSituations(sql, "de-autobahn-events", [situationDraft("seed")]);
  await sql`
    WITH copies AS MATERIALIZED (
    SELECT jsonb_populate_record(NULL::conditions.situation, to_jsonb(s) ||
      jsonb_build_object('id', n.id, 'canonical_id', n.id, 'source_record_id', n.local,
        'record', jsonb_set(jsonb_set(s.record, '{id}', to_jsonb(n.id)),
          '{provenance,recordId}', to_jsonb(n.local)))) AS row
    FROM conditions.situation s
    CROSS JOIN (SELECT 'item-' || lpad(i::text, 5, '0') AS local,
      'oc:situation:de-autobahn-events:item-' || lpad(i::text, 5, '0') AS id
      FROM generate_series(1, ${count}) i) n
    WHERE s.id = 'oc:situation:de-autobahn-events:seed')
    INSERT INTO conditions.situation SELECT (row).* FROM copies`;
  await sql`DELETE FROM conditions.situation WHERE source_record_id = 'seed'`;
}

const messageIds = (body: string) => [...body.matchAll(/<message id="([^"]+)"/g)].map((m) => m[1]);

describe("complete public TraFF feeds", () => {
  it("reads beyond a full internal page, including when every message on that page is withheld", async () => {
    await seed(5001);
    // An unknown source-axis direction cannot be faithfully projected to TraFF.
    await sql`UPDATE conditions.situation SET record = jsonb_set(record, '{location,direction}',
      '{"value":"negative","basis":"alert_c"}'::jsonb) WHERE source_record_id <> 'item-05001'`;
    const res = await app.inject(`/traff.xml?${AT}`);
    expect(res.statusCode).toBe(200);
    expect(messageIds(res.body)).toEqual(["oc:situation:de-autobahn-events:item-05001"]);
    expect(res.headers["link"]).toBeUndefined();
  });

  it("delivers every eligible record once in one HTTP response", async () => {
    await seed(5001);
    const res = await app.inject(`/traff.xml?${AT}`);
    expect(res.statusCode).toBe(200);
    const ids = messageIds(res.body);
    expect(ids).toHaveLength(5001);
    expect(new Set(ids).size).toBe(5001);
    expect(ids.at(0)).toBe("oc:situation:de-autobahn-events:item-00001");
    expect(ids.at(-1)).toBe("oc:situation:de-autobahn-events:item-05001");
    expect(res.headers["link"]).toBeUndefined();
  });

  it("refuses oversized selections without sending a partial XML document", async () => {
    await seed(20001);
    const res = await app.inject(`/traff.xml?${AT}`);
    expect(res.statusCode).toBe(413);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).not.toContain("<feed");
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/narrow/i) });
    const narrowed = await app.inject(`/traff.xml?${AT}&source=not-a-source`);
    expect(narrowed.statusCode).toBe(200);
    expect(messageIds(narrowed.body)).toEqual([]);
  });

  it("bounds UTF-8 bytes even when a small selection contains very large text", async () => {
    await seed(1);
    await sql`UPDATE conditions.situation SET record = jsonb_set(record, '{location,roads}',
      jsonb_build_array(jsonb_build_object('ref', repeat('é', 17 * 1024 * 1024))))`;
    const res = await app.inject(`/traff.xml?${AT}`);
    expect(res.statusCode).toBe(413);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("<feed");
  });

  it.each(["limit=1", "cursor=oc%3Asituation%3Ax%3Ay"])(
    "rejects page controls (%s)",
    async (query) => {
      const res = await app.inject(`/traff.xml?${AT}&${query}`);
      expect(res.statusCode).toBe(400);
    },
  );

  it("keeps public licence and source restrictions even with the operator token", async () => {
    const source = "de-autobahn-events";
    const draft = situationDraft("sa");
    await writeSituations(sql, source, [
      situationDraft("open"),
      {
        ...draft,
        provenance: {
          ...(draft["provenance"] as Record<string, unknown>),
          attribution: { provider: "SA", license: "CC-BY-SA-4.0" },
        },
      },
    ]);
    await writeSituations(sql, "traff-restricted", [
      situationDraft("secret", {}, "traff-restricted"),
    ]);
    await syncSources(sql, [
      {
        id: "traff-restricted",
        domain: "roads",
        format: "autobahn",
        product: "events",
        tier: "authoritative",
        country: "DE",
        operator: "test",
        license: "CC0-1.0",
        attribution: "test",
        restricted: true,
        cadenceSec: 60,
        freshnessWindowSec: 3600,
      },
    ]);
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}` }]) {
      const res = await app.inject({ url: `/traff.xml?${AT}`, headers });
      expect(res.statusCode).toBe(200);
      expect(messageIds(res.body)).toEqual(["oc:situation:de-autobahn-events:open"]);
      expect(res.headers["x-data-license"]).toBe("DL-DE-BY-2.0");
    }
  });
});
