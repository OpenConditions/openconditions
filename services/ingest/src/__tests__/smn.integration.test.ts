import { readFileSync } from "node:fs";
import { buildRegistry } from "@openconditions/model";
import { productionModules } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { createParseProcess } from "../pipeline/parse-process.js";
import { createRoleState, runSource } from "../pipeline/run.js";
import { REPO_CATALOG, repoFeed } from "./helpers/catalog.js";

const dir = new URL("../../../../packages/hazards/src/__tests__/fixtures/smn/", import.meta.url);
const cap = readFileSync(new URL("cap-1.xml", dir), "utf8");
const id = /<identifier>(.*?)<\/identifier>/.exec(cap)![1]!;
const sent = /<sent>(.*?)<\/sent>/.exec(cap)![1]!;
const url = "https://ssl.smn.gob.ar/feeds/CAP/xml_generados/CAP_test.xml";
const feed = repoFeed("ar-smn-alerts");
const registry = buildRegistry(productionModules);
let clock = "2026-11-07T15:48:00Z";
let app: ReturnType<typeof Fastify>;
const parser = createParseProcess({ minBytes: 1 });
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [{ ...feed }]);
  app = Fastify();
  registerScope(app, "test-operator-token-351");
  registerApiRoutes(app, db.sql, { registry, now: () => new Date(clock), catalog: REPO_CATALOG });
  await app.ready();
});
afterAll(async () => {
  await parser.close();
  await app?.close();
  await db?.close();
});
it("retains rolling messages across restart, applies cancel without info and refuses partial children", async () => {
  let body = cap;
  const indexLinks = [url];
  let broken = false;

  const fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("AR.php"))
      return new Response(
        `<rss version="2.0"><channel><lastBuildDate>Sat, 07 Nov 2026 15:48:00 GMT</lastBuildDate><copyright>Licencia CC BY 4.0</copyright>${indexLinks.map((link) => `<item><link>${link}</link></item>`).join("")}</channel></rss>`,
      );
    return broken ? new Response("failed", { status: 503 }) : new Response(body);
  }) as typeof globalThis.fetch;
  const tick = () =>
    runSource(feed, {
      sql: db.sql,
      fetch,
      now: () => clock,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      model: { registry, instanceId: "test.local" },
      roles: createRoleState(),
      parseProcess: parser,
    });
  const live = () =>
    db.sql`SELECT id, ST_IsValid(geom) AS valid FROM conditions.situation WHERE source_id=${feed.id} AND tombstoned_at IS NULL`;
  expect((await tick()).error).toBeUndefined();
  expect(parser.running).toBe(true);
  expect(await live()).toHaveLength(1);
  expect((await live())[0]!.valid).toBe(true);
  const response = await app.inject({
    method: "GET",
    url: "/situations?domain=hazards&kind=alert",
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["x-data-license"]).toContain("LicenseRef-CC-BY-2.5-AR");
  expect(response.body).toContain("Evitá salir");
  expect(response.body).toContain("normalizado por OpenConditions");
  expect(response.body).toContain(id);
  const sources = await app.inject({ method: "GET", url: "/sources" });
  expect(sources.body).toContain(feed.id);
  expect(sources.body).toContain("LicenseRef-CC-BY-2.5-AR");
  // Synthetic unrelated warning on the next rolling page cannot withdraw the first.
  body = cap.replace(id, `${id}.sibling`);
  expect((await tick()).error).toBeUndefined();
  expect(await live()).toHaveLength(2);
  broken = true;
  expect((await tick()).error).toBeDefined();
  expect(await live()).toHaveLength(2);
  broken = false;
  // Synthetic CAP cancellation, intentionally no info block.
  body = cap
    .replace(id, `${id}.cancel`)
    .replace("<msgType>Update</msgType>", "<msgType>Cancel</msgType>")
    .replace(
      /<references>.*?<\/references>/s,
      `<references>smn@smn.gob.ar,${id},${sent}</references>`,
    )
    .replace(/<info>.*<\/info>/s, "");
  expect((await tick()).error).toBeUndefined();
  expect(await live()).toHaveLength(1);
  body = cap;
  expect((await tick()).error).toBeUndefined();
  expect(await live()).toHaveLength(1);
  clock = "2026-11-07T19:48:00Z";
  expect((await tick()).error).toBeUndefined();
  expect(await live()).toHaveLength(0);
});

it("seals the researched wind and duplicate-vertex Zonda polygons, then expires indexed Zonda", async () => {
  const source = { ...feed, id: "ar-smn-original-alerts" };
  const wind = readFileSync(new URL("wind-original.xml", dir));
  const zonda = readFileSync(new URL("zonda-original.xml", dir));
  let at = "2026-11-06T23:55:00Z";
  const paths = ["CAP_wind.xml", "CAP_zonda.xml"].map(
    (name) => `https://ssl.smn.gob.ar/feeds/CAP/xml_generados/${name}`,
  );
  const fetch = (async (input: string | URL | Request) =>
    String(input).endsWith("AR.php")
      ? new Response(
          `<rss version="2.0"><channel><lastBuildDate>${new Date(at).toUTCString()}</lastBuildDate><copyright>Licencia CC BY 4.0</copyright>${paths.map((link) => `<item><link>${link}</link></item>`).join("")}</channel></rss>`,
        )
      : new Response(String(input) === paths[0] ? wind : zonda)) as typeof globalThis.fetch;
  const tick = () =>
    runSource(source, {
      sql: db.sql,
      fetch,
      now: () => at,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      model: { registry, instanceId: "test.local" },
      roles: createRoleState(),
      parseProcess: parser,
    });
  expect((await tick()).error).toBeUndefined();
  const rows =
    await db.sql`SELECT id, ST_IsValid(geom) AS valid, record FROM conditions.situation WHERE source_id=${source.id} AND tombstoned_at IS NULL`;
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.valid)).toBe(true);
  expect(JSON.stringify(rows)).toContain("2026-11-06T20:52:57-03:00");
  expect(JSON.stringify(rows)).toContain("2026-11-07T09:00:00-03:00");
  at = "2026-11-07T00:28:33Z";
  expect((await tick()).error).toBeUndefined();
  expect(
    await db.sql`SELECT id FROM conditions.situation WHERE source_id=${source.id} AND tombstoned_at IS NULL`,
  ).toHaveLength(1);
});

it("refuses a stale durable window after another worker commits", async () => {
  const { smnMessages, checkSmnWindow, storeSmnMessages } = await import(
    "../pipeline/smn-messages.js"
  );
  const source = { ...feed, id: "ar-smn-concurrency-alerts" };
  const now = "2026-11-07T15:48:00Z";
  const first = await smnMessages(db.sql, source, [Buffer.from(cap)], now);
  const stale = await smnMessages(db.sql, source, [], now);
  await db.sql.begin(async (tx) => {
    await checkSmnWindow(tx, source.id, first, now);
    await storeSmnMessages(tx, source.id, first.messages, now);
  });
  await expect(db.sql.begin((tx) => checkSmnWindow(tx, source.id, stale, now))).rejects.toThrow(
    "concurrent bulletin changed",
  );
});

it("retains both hazards, exact durable bytes and validators after a malformed secondary hazard", async () => {
  const conditionals: (string | null)[] = [];
  const source = { ...feed, id: "ar-smn-partial-alerts", requestLimits: undefined };
  const info = cap.match(/<info>.*<\/info>/s)![0]!;
  const original = cap.replace(
    "</alert>",
    info.replace("<severity>Moderate</severity>", "<severity>Severe</severity>") + "</alert>",
  );
  let body = original;
  let version = "v1";
  let elapsedClock: number | undefined;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    conditionals.push(new Headers(init?.headers).get("if-none-match"));
    if (elapsedClock !== undefined)
      elapsedClock += String(input).endsWith("AR.php") ? 59000 : 62000;
    return new Response(
      String(input).endsWith("AR.php")
        ? `<rss version="2.0"><channel><lastBuildDate>Sat, 07 Nov 2026 15:48:00 GMT</lastBuildDate><copyright>Licencia CC BY 4.0</copyright><item><link>${url}</link></item></channel></rss>`
        : body,
      { headers: { etag: version } },
    );
  }) as typeof globalThis.fetch;
  const tick = () =>
    runSource(source, {
      sql: db.sql,
      fetch,
      now: () => "2026-11-07T15:48:00Z",
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      model: { registry, instanceId: "test.local" },
      roles: createRoleState(),
      parseProcess: parser,
    });
  const live = () =>
    db.sql`SELECT id, record FROM conditions.situation WHERE source_id=${source.id} AND tombstoned_at IS NULL ORDER BY id`;
  const durable = () =>
    db.sql`SELECT identifier, body FROM conditions.smn_cap_message WHERE source_id=${source.id} ORDER BY identifier`;
  expect((await tick()).error).toBeUndefined();
  expect(parser.running).toBe(true);
  const before = await live();
  expect(before).toHaveLength(2);
  const originals = await durable();
  expect(originals[0]!.body).toEqual(Buffer.from(original));
  expect(conditionals).toEqual([null, null]);
  body = original.replace("<severity>Severe</severity>", "<severity>INVALID</severity>");
  version = "v2";
  expect((await tick()).error).toBeDefined();
  expect(await live()).toEqual(before);
  expect(await durable()).toEqual(originals);
  expect((await tick()).error).toBeDefined();
  expect(conditionals).toEqual([null, null, "v1", "v1", "v1", "v1"]);
  body = original;
  elapsedClock = Date.parse("2026-11-07T15:48:00Z");
  const spy = vi.spyOn(Date, "now").mockImplementation(() => elapsedClock!);
  try {
    expect((await tick()).error).toContain("time budget");
  } finally {
    spy.mockRestore();
    elapsedClock = undefined;
  }
  expect(await live()).toEqual(before);
  expect(await durable()).toEqual(originals);
  expect((await tick()).error).toBeUndefined();
  expect(conditionals.slice(-4)).toEqual(["v1", "v1", "v1", "v1"]);
});
