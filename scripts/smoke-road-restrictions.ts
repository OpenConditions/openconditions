/**
 * Thin entry point for the restriction smoke check. All composition lives in
 * the ingest ops module so the command and the service share one code path.
 *
 * Usage:
 *   tsx scripts/smoke-road-restrictions.ts --source fi-digitraffic --output <dir>
 *   tsx scripts/smoke-road-restrictions.ts --source fi-digitraffic --output <dir> \
 *     --database disposable --spine <reviewed spine JSON>
 */
import { main } from "../services/ingest/src/ops/smoke-road-restrictions.js";

await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`[smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
