import { runMigrations } from "@openconditions/core/server";
import Fastify from "fastify";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerApiRoutes } from "../api/routes.js";
import { buildDomainRegistry } from "../domains.js";
import { FeedStatusStore } from "../feed-status.js";
import { registerPublishRoutes } from "../publish-routes.js";
import { registry as model, situationDraft, writeSituations } from "./helpers/situations.js";

const BBOX = "13,52,14,53";

let sql: postgres.Sql;
let containerStop: () => Promise<unknown>;

beforeAll(async () => {
  const container = await new GenericContainer("postgis/postgis:16-3.4")
    .withEnvironment({
      POSTGRES_DB: "conditions_test",
      POSTGRES_USER: "oc",
      POSTGRES_PASSWORD: "oc",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  containerStop = () => container.stop();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const url = `postgres://oc:oc@${host}:${port}/conditions_test`;
  sql = postgres(url, { max: 3 });

  await runMigrations(url);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await containerStop?.();
}, 30_000);

describe("license enforcement on the redistributable export routes", () => {
  it("does not let unbound geometry bypass the direct Valhalla evidence gate", async () => {
    const closure = (local: string, coordinates: [number, number], license: string) => {
      const draft = situationDraft(local, {}, "lic-test-valhalla");
      return situationDraft(
        local,
        {
          location: {
            geometry: { type: "Point", coordinates },
            extent: "point",
            geometryOrigin: "source",
            fuzziness: "exact",
            admin: { country: "DE" },
          },
          provenance: {
            ...(draft["provenance"] as Record<string, unknown>),
            attribution: { provider: "p", license },
          },
        },
        "lic-test-valhalla",
      );
    };
    await writeSituations(sql, "lic-test-valhalla", [
      closure("vh-sa-1", [13.41, 52.51], "CC-BY-SA-4.0"),
      closure("vh-ok-1", [13.45, 52.55], "CC-BY-4.0"),
    ]);

    const app = Fastify();
    const registry = await buildDomainRegistry();
    registerPublishRoutes(app, sql, new FeedStatusStore(), registry);
    await app.ready();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/valhalla/exclusions.json?bbox=${BBOX}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        exclude_locations: { lon: number; lat: number }[];
        routing_evidence?: { schema_version?: number; conditions?: unknown[] };
      };
      expect(body.exclude_locations).toEqual([]);
      expect(body.routing_evidence).toMatchObject({ schema_version: 2, conditions: [] });
      expect(res.headers["x-data-license"]).toBe("unknown");
    } finally {
      await app.close();
    }
  });

  describe("GET /stream (SSE)", () => {
    it("never emits a CC-BY-SA record", async () => {
      const licensed = (local: string, source: string, license: string) => {
        const draft = situationDraft(local, {}, source);
        return {
          ...draft,
          location: {
            ...(draft["location"] as Record<string, unknown>),
            geometry: { type: "Point", coordinates: [13.9, 52.9] },
            extent: "point",
          },
          provenance: {
            ...(draft["provenance"] as Record<string, unknown>),
            attribution: { provider: source, license },
          },
        };
      };
      await writeSituations(sql, "lic-test-sa", [
        licensed("sse-sa-1", "lic-test-sa", "CC-BY-SA-4.0"),
      ]);
      await writeSituations(sql, "lic-test-ok", [licensed("sse-ok-1", "lic-test-ok", "CC-BY-4.0")]);

      const app = Fastify();
      registerApiRoutes(app, sql, { registry: model });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const readFrames = async (url: string): Promise<string> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);
        try {
          const res = await fetch(url, { signal: controller.signal });
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          try {
            while (!buf.includes("\n\n")) {
              const { value, done } = await reader.read();
              if (done) break;
              if (value) buf += decoder.decode(value, { stream: true });
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
          return buf;
        } finally {
          clearTimeout(timeout);
        }
      };

      try {
        const frames = await readFrames(`http://127.0.0.1:${port}/stream?bbox=${BBOX}`);
        expect(frames).toContain("oc:situation:lic-test-ok:sse-ok-1");
        expect(frames).not.toContain("sse-sa-1");
      } finally {
        await app.close();
      }
    }, 15_000);
  });
});
