import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readCapXml } from "@openconditions/hazards";
import { buildRegistry } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import { createTestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { checkSmnWindow, smnMessages } from "../pipeline/smn-messages.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";

// Recorded HTTP replay: no provider traffic and no synthetic provider messages.
const dir = new URL(
  "../../../../packages/hazards/src/__tests__/fixtures/smn/generation-20261109/",
  import.meta.url,
);
const captures = JSON.parse(readFileSync(new URL("provenance.json", dir), "utf8")) as {
  url: string;
  file: string;
  sha256: string;
  headers: Record<string, string>;
}[];
const at = "2026-11-09T07:11:40Z";
it("publishes all independent current captured variants as partial scope with lossless durable originals", async () => {
  const db = await createTestDatabase();
  let parser = createParseProcess({ minBytes: 1 });
  const registry = buildRegistry(productionModules);
  const app = Fastify();
  const feed = repoFeed("ar-smn-alerts");
  expect(REPO_CATALOG.feeds.some((f) => f.id === feed.id)).toBe(true);
  expect(REPO_CATALOG.disabled.some((f) => f.id === "ar-smn-acp-alerts")).toBe(true);
  const children = captures.filter((c) => c.file.startsWith("ar-"));
  const messages = children.map((c) => ({ capture: c, body: readFileSync(new URL(c.file, dir)) }));
  for (const m of messages)
    expect(createHash("sha256").update(m.body).digest("hex")).toBe(m.capture.sha256);
  const active = messages
    .map((m) => readCapXml(m.body, true))
    .filter((a) => Date.parse(a.info![0]!.expires!) > Date.parse(at));
  expect(children).toHaveLength(41);
  expect(active).toHaveLength(33);
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const capture = captures.find((c) => c.url === String(input));
    if (!capture) throw new Error(`uncaptured URL: ${input}`);
    calls.push(capture.url);
    return new Response(readFileSync(new URL(capture.file, dir)), { headers: capture.headers });
  }) as typeof globalThis.fetch;
  registerScope(app, "test-operator-token-351-generation");
  registerApiRoutes(app, db.sql, { registry, now: () => new Date(at), catalog: REPO_CATALOG });
  try {
    // Synthetic one-link index over an unchanged real CAP establishes last-good state.
    const seed = messages[0]!;
    const seedFetch = (async (input: string | URL | Request) =>
      String(input).endsWith("AR.php")
        ? new Response(
            `<rss version="2.0"><channel><lastBuildDate>${new Date(at).toUTCString()}</lastBuildDate><copyright>Licencia CC BY 4.0</copyright><item><link>${seed.capture.url}</link></item></channel></rss>`,
          )
        : new Response(seed.body)) as typeof globalThis.fetch;
    const seedResult = await runSource(
      { ...feed, requestLimits: undefined },
      {
        sql: db.sql,
        fetch: seedFetch,
        now: () => at,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        model: { registry, instanceId: "test.local" },
        roles: createRoleState(),
        parseProcess: parser,
      },
    );
    expect(seedResult.error).toBeUndefined();
    expect(parser.running).toBe(true);
    const before =
      await db.sql`SELECT id, record FROM conditions.situation WHERE source_id=${feed.id} AND tombstoned_at IS NULL ORDER BY id`;
    expect(before).toHaveLength(1);
    // Replay removes the network pacer; provider pacing is measured in the capture receipt.
    const result = await runSource(
      { ...feed, requestLimits: undefined },
      {
        sql: db.sql,
        fetch,
        now: () => at,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        model: { registry, instanceId: "test.local" },
        roles: createRoleState(),
        parseProcess: parser,
      },
    );
    expect(result.error).toBeUndefined();
    expect(calls).toHaveLength(42);
    const durable =
      await db.sql`SELECT identifier, variant, body, retrieval, retain_until FROM conditions.smn_cap_message WHERE source_id=${feed.id} ORDER BY variant`;
    expect(durable).toHaveLength(41);
    for (const m of messages) {
      const row = durable.find((r) => Buffer.from(r.body).equals(m.body));
      expect(row?.variant).toBe(m.capture.sha256);
      expect(row?.retrieval).toMatchObject({ sha256: m.capture.sha256, source: feed.id });
      expect(row?.retrieval.fetchId).toBeGreaterThan(0);
    }
    const decision =
      await db.sql`SELECT decision FROM conditions.smn_cap_decision WHERE source_id=${feed.id}`;
    expect(decision[0]!.decision).toMatchObject({
      partial: true,
      accepted: 33,
      expired: 8,
      terminal: 8,
      withheld: 0,
      retained: 41,
    });
    expect(decision[0]!.decision.diagnostics).toHaveLength(41);
    const rows =
      await db.sql`SELECT id, record FROM conditions.situation WHERE source_id=${feed.id} AND tombstoned_at IS NULL ORDER BY id`;
    expect(rows).toHaveLength(33);
    expect(new Set(rows.map((r) => r.id)).size).toBe(33);
    const status =
      await db.sql`SELECT last_error FROM conditions.source_status WHERE source=${feed.id}`;
    expect(status[0]!.last_error).toContain("SMN partial");
    for (const m of messages) {
      const a = readCapXml(m.body, true);
      const r = rows.find((r) => r.id.endsWith(m.capture.sha256));
      if (Date.parse(a.info![0]!.expires!) <= Date.parse(at)) {
        expect(r).toBeUndefined();
        continue;
      }
      expect(r).toBeDefined();
      const info = a.info![0]!;
      expect(r!.record.details.cap).toMatchObject({
        identifier: a.identifier,
        sender: a.sender,
        sent: a.sent,
        event: [{ lang: "es-AR", text: info.event }],
        references: [expect.objectContaining({ identifier: expect.any(String) })],
        expires: info.expires,
      });
      expect(r!.record.instruction).toEqual([{ lang: "es-AR", text: info.instruction }]);
      const area = info.area![0]!;
      const polygon = area.polygon![0]!;
      const sourcePoints = polygon
        .trim()
        .split(/\s+/)
        .map((p) => p.split(",").map(Number).reverse());
      const projectedPoints = r!.record.location.geometry.coordinates[0];
      expect(new Set(projectedPoints.map((p: number[]) => JSON.stringify(p)))).toEqual(
        new Set(sourcePoints.map((p) => JSON.stringify(p))),
      );
    }
    const response = await app.inject({
      method: "GET",
      url: "/situations?domain=hazards&kind=alert&limit=100",
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).records).toHaveLength(33);
    for (const r of JSON.parse(response.body).records) {
      expect(r.location.geometry).toBeDefined();
      expect(r.instruction).toBeDefined();
      expect(r.details.cap.expires).toBeDefined();
      expect(r.relations ?? []).toEqual([]);
      expect(r.groupId).toBeUndefined();
      expect(JSON.stringify(r)).toContain("LicenseRef-CC-BY-2.5-AR");
    }
    expect(await db.sql`SELECT 1 FROM conditions.observation`).toHaveLength(0);
    const staleWindow = await smnMessages(db.sql, feed, [], at);
    await parser.close();
    parser = createParseProcess({ minBytes: 1 });
    const replay = await runSource(
      { ...feed, requestLimits: undefined },
      {
        sql: db.sql,
        fetch,
        now: () => at,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        model: { registry, instanceId: "test.local" },
        roles: createRoleState(),
        parseProcess: parser,
      },
    );
    expect(replay.error).toBeUndefined();
    await expect(
      db.sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${feed.id}))`;
        await checkSmnWindow(tx, feed.id, staleWindow, at);
      }),
    ).rejects.toThrow("concurrent bulletin changed");
    expect(replay.durationMs).toBeLessThan(120000);
    const replayed =
      await db.sql`SELECT identifier,variant,body,retrieval,retain_until FROM conditions.smn_cap_message WHERE source_id=${feed.id} ORDER BY variant`;
    expect(replayed.map((r) => ({ ...r, retrieval: null }))).toEqual(
      durable.map((r) => ({ ...r, retrieval: null })),
    );
    for (let i = 0; i < durable.length; i++) {
      expect(replayed[i]!.retrieval.captures).toHaveLength(
        durable[i]!.retrieval.captures.length + 1,
      );
      expect(replayed[i]!.retrieval.captures.slice(0, -1)).toEqual(durable[i]!.retrieval.captures);
    }
    expect(
      await db.sql`SELECT id, record FROM conditions.situation WHERE source_id=${feed.id} AND tombstoned_at IS NULL ORDER BY id`,
    ).toEqual(rows);
    const groups = new Map<string, typeof messages>();
    for (const m of messages) {
      const id = readCapXml(m.body, true).identifier;
      groups.set(id, [...(groups.get(id) ?? []), m]);
    }
    const conflicts = [...groups.values()].filter(
      (g) => new Set(g.map((m) => m.capture.sha256)).size > 1,
    );
    expect(conflicts.length).toBeGreaterThan(0);
    const collision = conflicts[0]!;
    expect(
      new Set(collision.map((m) => readCapXml(m.body, true).info![0]!.event)).size,
    ).toBeGreaterThan(1);
    console.log(
      JSON.stringify({
        captured: 41,
        unexpired: active.length,
        expired: 8,
        identifiers: groups.size,
        conflictingIdentifiers: conflicts.length,
        published: rows.length,
      }),
    );
  } finally {
    await parser.close();
    await app.close();
    await db.close();
  }
});

// Synthetic poll sequencing over unchanged captured XML: this is not an observed provider sequence.
for (const order of [
  ["ar-000.xml", "ar-011.xml"],
  ["ar-011.xml", "ar-000.xml"],
]) {
  it(`retains both byte variants and canonical records across restart and mutation poll ${order.join(" -> ")}`, async () => {
    const db = await createTestDatabase();
    let parser = createParseProcess({ minBytes: 1 });
    const registry = buildRegistry(productionModules);
    const feed = { ...repoFeed("ar-smn-alerts"), requestLimits: undefined };
    const app = Fastify();
    const originals = order.map((name) => readFileSync(new URL(name, dir)));
    let body = originals[0]!;
    let version = "v1";
    const conditional: (string | null)[] = [];
    const child = "https://ssl.smn.gob.ar/feeds/CAP/xml_generados/CAP_test.xml";
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      conditional.push(new Headers(init?.headers).get("if-none-match"));
      return new Response(
        String(input).endsWith("AR.php")
          ? `<rss version="2.0"><channel><lastBuildDate>${new Date(at).toUTCString()}</lastBuildDate><copyright>Licencia CC BY 4.0</copyright><item><link>${child}</link></item></channel></rss>`
          : body,
        { headers: { etag: version } },
      );
    }) as typeof globalThis.fetch;
    const tick = () =>
      runSource(feed, {
        sql: db.sql,
        fetch,
        now: () => at,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        model: { registry, instanceId: "test.local" },
        roles: createRoleState(),
        parseProcess: parser,
      });
    const rows = () =>
      db.sql`SELECT id, record FROM conditions.situation WHERE source_id=${feed.id} AND tombstoned_at IS NULL ORDER BY id`;
    const durable = () =>
      db.sql`SELECT identifier, body, retain_until FROM conditions.smn_cap_message WHERE source_id=${feed.id} ORDER BY identifier`;
    registerScope(app, "test-operator-token-351-collision");
    registerApiRoutes(app, db.sql, { registry, now: () => new Date(at), catalog: REPO_CATALOG });
    try {
      expect(readCapXml(originals[0]!, true).identifier).toBe(
        readCapXml(originals[1]!, true).identifier,
      );
      expect(originals[0]!.equals(originals[1]!)).toBe(false);
      expect((await tick()).error).toBeUndefined();
      expect(await rows()).toHaveLength(1);
      const stored = await durable();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.body).toEqual(originals[0]);
      const apiBefore = await app.inject({
        method: "GET",
        url: "/situations?domain=hazards&kind=alert&limit=100",
      });
      expect(JSON.parse(apiBefore.body).records).toHaveLength(1);
      // A new parser and fresh role state ensure the protection is durable, not process memory.
      await parser.close();
      parser = createParseProcess({ minBytes: 1 });
      expect((await tick()).error).toBeUndefined();
      expect(await durable()).toEqual(stored);
      body = originals[1]!;
      version = "v2";
      expect((await tick()).error).toBeUndefined();
      const combined = await durable();
      expect(combined).toHaveLength(2);
      for (const original of originals)
        expect(combined.some((r) => Buffer.from(r.body).equals(original))).toBe(true);
      expect(await rows()).toHaveLength(2);
      expect((await tick()).error).toBeUndefined();
      expect(await durable()).toEqual(combined);
      const apiAfter = await app.inject({
        method: "GET",
        url: "/situations?domain=hazards&kind=alert&limit=100",
      });
      expect(JSON.parse(apiAfter.body).records).toHaveLength(2);
      body = originals[0]!;
      version = "v1";
      expect((await tick()).error).toBeUndefined();
      expect(await durable()).toEqual(combined);
      expect(await rows()).toHaveLength(2);
      // Synthetic ambiguous Cancel: neither real variant is a uniquely referenceable target.
      const alert = readCapXml(originals[0]!, true);
      body = Buffer.from(
        originals[0]!
          .toString()
          .replace(
            `<identifier>${alert.identifier}</identifier>`,
            `<identifier>${alert.identifier}.cancel</identifier>`,
          )
          .replace("<msgType>Update</msgType>", "<msgType>Cancel</msgType>")
          .replace(
            /<references>.*?<\/references>/s,
            `<references>${alert.sender},${alert.identifier},${alert.sent}</references>`,
          )
          .replace(/<info>.*<\/info>/s, ""),
      );
      version = "v3";
      expect((await tick()).error).toBeUndefined();
      expect(await durable()).toHaveLength(3);
      expect(await rows()).toHaveLength(0);
      const decision =
        await db.sql`SELECT decision FROM conditions.smn_cap_decision WHERE source_id=${feed.id}`;
      expect(decision[0]!.decision).toMatchObject({ withheld: 3, terminal: 0, accepted: 0 });
      expect(
        decision[0]!.decision.diagnostics.some(
          (d: { reason: string }) => d.reason === "ambiguous-lifecycle",
        ),
      ).toBe(true);
      body = originals[0]!;
      expect((await tick()).error).toBeUndefined();
      expect(await rows()).toHaveLength(0);
      const all = await durable();
      body = Buffer.from("<alert>broken</alert>");
      version = "v4";
      expect((await tick()).error).toBeDefined();
      expect(await durable()).toEqual(all);
      expect(
        await db.sql`SELECT decision FROM conditions.smn_cap_decision WHERE source_id=${feed.id}`,
      ).toEqual(decision);
      expect(conditional.slice(-2)).toEqual(["v3", "v3"]);
    } finally {
      await parser.close();
      await app.close();
      await db.close();
    }
  });
}

it("upgrades the existing one-ID durable table without changing its original bytes or retention claim", async () => {
  const db = await createTestDatabase();
  try {
    await db.sql`DROP TABLE conditions.smn_cap_decision`;
    await db.sql`DROP TABLE conditions.smn_cap_message`;
    const migrations = new URL("../../../../packages/core/drizzle/", import.meta.url);
    await db.sql.unsafe(readFileSync(new URL("0093_smn_cap_message.sql", migrations), "utf8"));
    const original = readFileSync(new URL("ar-000.xml", dir));
    const alert = readCapXml(original, true);
    await db.sql`INSERT INTO conditions.smn_cap_message(source_id,identifier,body,retain_until) VALUES ('legacy',${alert.identifier},${original},'2026-11-15T23:13:22Z')`;
    const migration = readFileSync(new URL("0094_glorious_adam_destine.sql", migrations), "utf8");
    for (const statement of migration.split("--> statement-breakpoint"))
      await db.sql.unsafe(statement);
    const rows =
      await db.sql`SELECT identifier,variant,body,retrieval,retain_until FROM conditions.smn_cap_message`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).toBe(alert.identifier);
    expect(rows[0]!.body).toEqual(original);
    expect(rows[0]!.retrieval).toEqual({ legacy: true });
    expect(rows[0]!.retain_until.toISOString()).toBe("2026-11-15T23:13:22.000Z");
    expect(rows[0]!.variant).toBe(createHash("sha256").update(original).digest("hex"));
    const sibling = readFileSync(new URL("ar-011.xml", dir));
    await db.sql`INSERT INTO conditions.smn_cap_message(source_id,identifier,body,retain_until) VALUES ('legacy',${alert.identifier},${sibling},'2026-11-15T23:13:22Z')`;
    expect(await db.sql`SELECT body FROM conditions.smn_cap_message`).toHaveLength(2);
  } finally {
    await db.close();
  }
});

it("bounds variants by count and combined original/provenance bytes before publication", async () => {
  const db = await createTestDatabase();
  try {
    const feed = repoFeed("ar-smn-alerts");
    const original = readFileSync(new URL("ar-000.xml", dir));
    // Synthetic byte variants over the same CAP; these are budget probes, not provider messages.
    const variants = Array.from({ length: 4097 }, (_, n) =>
      Buffer.concat([original, Buffer.from(`<!-- synthetic ${n} -->`)]),
    );
    await expect(smnMessages(db.sql, feed, variants, at)).rejects.toThrow("budget exceeded");
    expect(await db.sql`SELECT body FROM conditions.smn_cap_message`).toHaveLength(0);
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1, 32);
    await db.sql`INSERT INTO conditions.smn_cap_message(source_id,identifier,body,retain_until) VALUES (${feed.id},'synthetic-budget',${oversized},'2026-11-15T23:13:22Z')`;
    await expect(smnMessages(db.sql, feed, [], at)).rejects.toThrow("budget exceeded");
  } finally {
    await db.close();
  }
});

// Synthetic expired malformed update must not acquire authority over a valid warning.
it.each(["severity", "grouped-event"])(
  "refuses expired malformed %s lifecycle actions without changing durable or public last-good state",
  async (mode) => {
    const db = await createTestDatabase();
    const parser = createParseProcess({ minBytes: 1 });
    const registry = buildRegistry(productionModules);
    const feed = { ...repoFeed("ar-smn-alerts"), requestLimits: undefined };
    const original = readFileSync(new URL("ar-000.xml", dir), "utf8");
    const base = readCapXml(Buffer.from(original), true);
    let body = Buffer.from(
      original
        .replace(/<msgType>.*?<\/msgType>/, "<msgType>Alert</msgType>")
        .replace(/<references>.*?<\/references>/s, "<references></references>"),
    );
    let version = "v1";
    const child = "https://ssl.smn.gob.ar/feeds/CAP/xml_generados/CAP_synthetic.xml";
    const fetch = (async (input: string | URL | Request) =>
      new Response(
        String(input).endsWith("AR.php")
          ? `<rss version="2.0"><channel><lastBuildDate>${new Date(at).toUTCString()}</lastBuildDate><copyright>Licencia CC BY 4.0</copyright><item><link>${child}</link></item></channel></rss>`
          : body,
        { headers: { etag: version } },
      )) as typeof globalThis.fetch;
    const tick = () =>
      runSource(feed, {
        sql: db.sql,
        fetch,
        now: () => at,
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        model: { registry, instanceId: "test.local" },
        roles: createRoleState(),
        parseProcess: parser,
      });
    const originals = () => db.sql`SELECT * FROM conditions.smn_cap_message ORDER BY variant`;
    const rows = () => db.sql`SELECT id,record,tombstoned_at FROM conditions.situation ORDER BY id`;
    const decisions = () => db.sql`SELECT * FROM conditions.smn_cap_decision`;
    const app = Fastify();
    registerScope(app, "synthetic-expired-malformed");
    registerApiRoutes(app, db.sql, { registry, now: () => new Date(at), catalog: REPO_CATALOG });
    try {
      expect((await tick()).error).toBeUndefined();
      const before = {
        originals: await originals(),
        rows: await rows(),
        decisions: await decisions(),
      };
      const api = await app.inject({ url: "/situations?domain=hazards&kind=alert" });
      expect(JSON.parse(api.body).records).toHaveLength(1);
      body = Buffer.from(
        original
          .replace(/<identifier>.*?<\/identifier>/, "<identifier>synthetic-bad-update</identifier>")
          .replace(
            /<references>.*?<\/references>/s,
            `<references>${base.sender},${base.identifier},${base.sent}</references>`,
          )
          .replace(/<expires>.*?<\/expires>/, "<expires>2026-11-09T06:00:00Z</expires>")
          .replace(/<severity>.*?<\/severity>/, "<severity>INVALID</severity>"),
      );
      if (mode === "grouped-event") {
        const xml = body
          .toString()
          .replace("<severity>INVALID</severity>", "<severity>Moderate</severity>");
        const info = xml.match(/<info>.*<\/info>/s)![0]!;
        body = Buffer.from(
          xml.replace(info, info + info.replace(/<event>.*?<\/event>/s, "<event></event>")),
        );
      }
      version = "v2";
      expect((await tick()).error).toBeDefined();
      expect(await originals()).toEqual(before.originals);
      expect(await rows()).toEqual(before.rows);
      expect(await decisions()).toEqual(before.decisions);
      const after = await app.inject({ url: "/situations?domain=hazards&kind=alert" });
      expect(JSON.parse(after.body).records).toEqual(JSON.parse(api.body).records);
    } finally {
      await parser.close();
      await app.close();
      await db.close();
    }
  },
);
