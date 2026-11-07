import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { productionRegistry } from "@openconditions/model-registry";
import { syncSources } from "@openconditions/storage";
import { createTestDatabase, type TestDatabase } from "@openconditions/test-database";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { registerScope } from "../api/scope.js";
import { runSource } from "../pipeline/run.js";
import { repoFeed } from "./helpers/catalog.js";

const capture = JSON.parse(
  readFileSync(
    new URL("../../../../packages/charging/src/__tests__/fixtures/pun-uta.json", import.meta.url),
    "utf8",
  ),
);
const feed = repoFeed("it-agid-pun-charging");
const registry = productionRegistry();
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await syncSources(db.sql, [feed]);
}, 120000);
afterAll(async () => {
  await db?.close();
}, 30000);
async function poll(shards = [capture], mode = "ok") {
  const bodies = shards.map((s) => Buffer.from(JSON.stringify(s)));
  const files = bodies.map((b, i) => ({
    key: `pun/${String(92090 + i).padStart(6, "0")}.json`,
    size: b.length,
    md5: createHash("md5").update(b).digest("hex"),
  }));
  let manifests = 0;
  return runSource(feed, {
    sql: db.sql,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("manifest.json")) {
        manifests++;
        return new Response(
          JSON.stringify({
            sources: {
              pun: {
                status: mode === "error" ? "error" : "ok",
                last_run:
                  mode === "mixed" && manifests === 2
                    ? "2026-11-07T07:08:53Z"
                    : "2026-11-06T07:08:53Z",
                files,
              },
            },
          }),
        );
      }
      const index = files.findIndex((f) => url.endsWith(f.key));
      return mode === "partial" && index === 1
        ? new Response(null, { status: 404 })
        : new Response(mode === "digest" ? "bad" : bodies[index]);
    },
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    now: () => "2026-11-07T12:00:00Z",
    model: { registry, instanceId: "test.local" },
  });
}
const live = async () =>
  (
    await db.sql<
      { id: string }[]
    >`SELECT id FROM conditions.feature WHERE source_id=${feed.id} AND tombstoned_at IS NULL ORDER BY id`
  ).map((r) => r.id);
it("acquisition → real pipeline → PostGIS → public API; errors retain last-good and only complete mirror subsets withdraw", async () => {
  const first = await poll();
  expect(first.outcome).toBe("changed");
  expect(await live()).toHaveLength(18);
  const before = await live();
  for (const mode of ["error", "mixed", "digest", "partial"]) {
    const result = await poll([capture, capture], mode);
    expect(result.outcome).not.toBe("changed");
    expect(await live()).toEqual(before);
  }
  expect((await poll([{ ...capture, punti: [] }])).outcome).not.toBe("changed");
  expect(await live()).toEqual(before);
  const app = Fastify();
  registerScope(app, "pun-test-operator-token");
  registerApiRoutes(app, db.sql, { registry, now: () => new Date("2026-11-07T12:00:00Z") });
  await app.ready();
  try {
    const response = await app.inject({
      url: "/features?bbox=8,38,10,41&kind=charging_site&canonical=1",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("GSE/MASE");
    expect(response.body).not.toContain("charging.evse_status");
  } finally {
    await app.close();
  }
  const subset = { ...capture, punti: capture.punti.slice(0, 17) };
  expect((await poll([subset])).outcome).toBe("changed");
  expect(await live()).toHaveLength(17);
  const [{ observations }] = await db.sql<
    { observations: number }[]
  >`SELECT count(*)::int AS observations FROM conditions.observation_latest WHERE source_id=${feed.id}`;
  expect(observations).toBe(0);
}, 120000);
