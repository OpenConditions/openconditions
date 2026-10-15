/** Offline development spike. Synthetic data and disposable local PostGIS only.
 * Run after pnpm build: pnpm --filter @openconditions/ingest exec tsx src/__tests__/bench-public-stream.integration.ts
 * Measures real /stream snapshot delivery; never connects to an operator database.
 */
import { performance } from "node:perf_hooks";
import { runMigrations } from "@openconditions/core/server";
import Fastify from "fastify";
import postgres from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { registerApiRoutes } from "../api/routes.js";
import { registry, situationDraft, writeSituations } from "./helpers/situations.js";

const container = await new GenericContainer("postgis/postgis:16-3.4")
  .withEnvironment({ POSTGRES_DB: "stream_spike", POSTGRES_USER: "oc", POSTGRES_PASSWORD: "oc" })
  .withCommand(["postgres", "-c", "fsync=off"])
  .withExposedPorts(5432)
  .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
  .withStartupTimeout(120_000)
  .start();
let sql: postgres.Sql | undefined;
let app: ReturnType<typeof Fastify> | undefined;
try {
  const url = `postgres://oc:oc@${container.getHost()}:${container.getMappedPort(5432)}/stream_spike`;
  await runMigrations(url);
  let queries = 0;
  sql = postgres(url, {
    max: 4,
    onnotice: () => {},
    debug: (_connection, query) => {
      if (query.includes("SELECT s.id,")) queries++;
    },
  });
  app = Fastify();
  registerApiRoutes(app, sql, { registry });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  async function snapshot(expected: number, lastEventId?: string) {
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 60_000);
    const start = performance.now();
    const before = queries;
    try {
      const response = await fetch(`${address}/stream`, {
        signal: abort.signal,
        ...(lastEventId ? { headers: { "Last-Event-ID": lastEventId } } : {}),
      });
      if (!response.ok || !response.body) throw new Error(`stream returned ${response.status}`);
      let bytes = 0;
      let count = 0;
      let tail = "";
      let receivedId = "";
      let firstMs: number | undefined;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (count < expected) {
        const { done, value } = await reader.read();
        if (done) throw new Error("stream ended early");
        firstMs ??= performance.now() - start;
        bytes += value.length;
        tail += decoder.decode(value, { stream: true });
        const frames = tail.split("\n\n");
        tail = frames.pop() ?? "";
        for (const frame of frames)
          if (frame.includes("event: situation\n")) {
            count++;
            receivedId = /^id: (.*)$/m.exec(frame)?.[1] ?? receivedId;
          }
      }
      await reader.cancel();
      return {
        count,
        lastEventId: receivedId,
        bytes,
        selectPages: queries - before,
        firstMs: Math.round(firstMs ?? 0),
        completeMs: Math.round(performance.now() - start),
      };
    } finally {
      clearTimeout(deadline);
      abort.abort();
    }
  }
  const results: unknown[] = [];
  for (const geometry of ["point", "line32"] as const) {
    const seed = situationDraft("seed", {
      location: {
        geometry:
          geometry === "point"
            ? { type: "Point", coordinates: [6.8, 51.2] }
            : {
                type: "LineString",
                coordinates: Array.from({ length: 32 }, (_, i) => [
                  6.8 + i / 1000,
                  51.2 + Math.sin(i) / 1000,
                ]),
              },
        extent: geometry === "point" ? "point" : "linear",
        geometryOrigin: "source",
        fuzziness: "exact",
      },
    });
    for (const size of [500, 5000, 20_000, 20_001]) {
      await sql`TRUNCATE conditions.situation CASCADE`;
      await writeSituations(sql, "de-autobahn-events", [seed]);
      // Replicate the stored synthetic fixture, preserving all materialized columns.
      // This is a read/transport benchmark, not an ingestion or hash-validation benchmark.
      console.error(`[stream benchmark] ${geometry}: ${size} rows`);
      const columns = await sql<
        { column_name: string }[]
      >`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'conditions' AND table_name = 'situation' AND is_generated = 'NEVER'
        ORDER BY ordinal_position`;
      const quoted = columns.map(({ column_name: c }) => `"${c.replaceAll('"', '""')}"`);
      const id = "'oc:situation:de-autobahn-events:bench-' || lpad(n::text, 6, '0')";
      const values = columns
        .map(({ column_name: c }, i) =>
          c === "id"
            ? id
            : c === "record"
              ? `s.record || jsonb_build_object('id', ${id})`
              : `s.${quoted[i]}`,
        )
        .join(", ");
      await sql.unsafe(
        `INSERT INTO conditions.situation (${quoted.join(", ")}) SELECT ${values}
        FROM conditions.situation s CROSS JOIN generate_series(1, $1::int) n`,
        [size - 1],
      );
      const initial = await snapshot(Math.min(size, 20_000));
      const reconnect = await snapshot(Math.min(size, 20_000), initial.lastEventId);
      results.push({ geometry, stored: size, initial, reconnect });
    }
  }
  console.log(
    "BENCHMARK_RESULT=" +
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        database: "postgis/postgis:16-3.4",
        scope: "synthetic local HTTP+PostGIS; no WAN/TLS/compression/concurrent writers",
        results,
      }),
  );
} finally {
  await app?.close();
  await sql?.end();
  await container.stop();
}
