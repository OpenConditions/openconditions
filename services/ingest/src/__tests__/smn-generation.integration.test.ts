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
it("refuses the complete real generation with conflicting CAP identities without publishing a partial snapshot", async () => {
  const db = await createTestDatabase();
  const parser = createParseProcess({ minBytes: 1 });
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
    expect(result.error).toContain("conflicting duplicate CAP identifier");
    expect(calls).toHaveLength(42);
    const durable =
      await db.sql`SELECT identifier, body FROM conditions.smn_cap_message WHERE source_id=${feed.id}`;
    expect(durable).toHaveLength(1);
    expect(durable[0]!.body).toEqual(seed.body);
    const rows =
      await db.sql`SELECT id, record FROM conditions.situation WHERE source_id=${feed.id} AND tombstoned_at IS NULL ORDER BY id`;
    expect(rows).toEqual(before);
    const response = await app.inject({
      method: "GET",
      url: "/situations?domain=hazards&kind=alert&limit=100",
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).records).toHaveLength(1);
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
  it(`preserves original bytes, canonical records and validators across restart and conflicting poll ${order.join(" -> ")}`, async () => {
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
      const before = await rows();
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
      expect((await tick()).error).toContain("conflicting duplicate CAP identifier");
      expect(await durable()).toEqual(stored);
      expect(await rows()).toEqual(before);
      expect((await tick()).error).toContain("conflicting duplicate CAP identifier");
      expect(conditional.slice(-4)).toEqual(["v1", "v1", "v1", "v1"]);
      const apiAfter = await app.inject({
        method: "GET",
        url: "/situations?domain=hazards&kind=alert&limit=100",
      });
      expect(JSON.parse(apiAfter.body).records).toEqual(JSON.parse(apiBefore.body).records);
      body = originals[0]!;
      version = "v1";
      expect((await tick()).error).toBeUndefined();
      expect(await durable()).toEqual(stored);
      expect(await rows()).toEqual(before);
    } finally {
      await parser.close();
      await app.close();
      await db.close();
    }
  });
}
