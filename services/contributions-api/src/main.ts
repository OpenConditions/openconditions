/**
 * Boot entry for the contributions service: applies migrations, opens the
 * shared postgres pool, builds the Fastify app, and listens. Tests import
 * build() from server.ts instead of running this file.
 */
import postgres from "postgres";
import { runMigrations } from "@openconditions/core/server";
import { build } from "./server.js";
import {
  isCrossValidateSweepEnabled,
  singleFlight,
  sweepCrossValidate,
  sweepFederatedCrossValidate,
} from "./evidence/crossValidateSweep.js";

const PORT = parseInt(process.env["PORT"] || "4200", 10);
const HOST = process.env["HOST"] || "0.0.0.0";

/**
 * How often the feed-arrives-later sweep re-runs A1 cross-validation over
 * still-unresolved crowd reports. A few minutes: an official feed confirming a
 * crowd report is not latency-critical, and this only patches the case A1's
 * landing hook misses.
 */
const CROSS_VALIDATE_SWEEP_MS = 3 * 60_000;

async function boot() {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  console.info("[contributions-api] applying database migrations…");
  await runMigrations(url);
  console.info("[contributions-api] migrations applied");

  const sql = postgres(url, { max: 5, idle_timeout: 30, connect_timeout: 10 });
  const app = await build({ sql });

  // Feed-arrives-later cross-match cron: re-runs the A1 cross-validation over
  // still-unresolved crowd reports so an official feed that lands AFTER a crowd
  // report retroactively routes it. Opt out with OPENCONDITIONS_CROSS_VALIDATE_SWEEP=off.
  let sweepTimer: NodeJS.Timeout | undefined;
  if (isCrossValidateSweepEnabled(process.env)) {
    // Single-flight so a slow cycle can never overlap itself. Both the local
    // (T2) sweep and the starvation-safe federated sweep run in the SAME tick
    // under the one guard — no second cron. Each is wrapped in its own try so a
    // failure in one never skips the other.
    const runSweep = singleFlight(async () => {
      try {
        const result = await sweepCrossValidate(sql, new Date().toISOString(), {
          log: (msg) => console.info(msg),
        });
        if (result.scanned > 0) {
          console.info(
            `[contributions-api] cross-validate sweep: scanned ${result.scanned}, routed ${result.routed}`
          );
        }
      } catch (err) {
        console.error("[contributions-api] cross-validate sweep failed:", err);
      }
      try {
        const fed = await sweepFederatedCrossValidate(sql, new Date().toISOString(), {
          log: (msg) => console.info(msg),
        });
        if (fed.scanned > 0) {
          console.info(
            `[contributions-api] federated cross-validate sweep: scanned ${fed.scanned}, routed ${fed.routed}`
          );
        }
      } catch (err) {
        console.error("[contributions-api] federated cross-validate sweep failed:", err);
      }
    });
    sweepTimer = setInterval(() => void runSweep(), CROSS_VALIDATE_SWEEP_MS);
  }

  const close = async () => {
    if (sweepTimer) clearInterval(sweepTimer);
    await app.close();
    await sql.end();
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  await app.listen({ port: PORT, host: HOST });
  console.info(`[contributions-api] listening on ${HOST}:${PORT}`);
}

boot().catch((err) => {
  console.error("[contributions-api] fatal:", err);
  process.exit(1);
});
