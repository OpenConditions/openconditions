import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hasCredentials } from "@openconditions/ingest-framework";
import type { FeedSourceBase } from "@openconditions/ingest-framework";
// buildDomainRegistry lives in the ingest service; it imports only built
// package names, so Node's native .ts execution resolves this explicit-.ts
// specifier. The feed set now comes from the built registry (baked-in +
// mounted + optional remote), not the dispatch-only static DOMAIN_REGISTRY.
import { buildDomainRegistry } from "../services/ingest/src/domains.ts";
import { renderReport, type FeedFailure } from "./lib/liveness-report.ts";
import { validateFeed } from "./lib/validate-feed.ts";

const REPORT_PATH = "liveness/out.md";

/** Keyless = no auth (or auth "none") and no requiredEnv — checkable without secrets. */
function isKeyless(feed: FeedSourceBase): boolean {
  const kind = feed.auth?.kind ?? "none";
  return kind === "none" && (feed.requiredEnv?.length ?? 0) === 0;
}

async function collectFailures(): Promise<FeedFailure[]> {
  const failures: FeedFailure[] = [];
  const registry = await buildDomainRegistry();
  for (const [domain, plugin] of Object.entries(registry)) {
    for (const feed of plugin.feeds) {
      if (!feed.enabledByDefault) continue;
      if (!isKeyless(feed) || !hasCredentials(feed)) continue;
      const result = await validateFeed(feed, { parserFor: plugin.parserFor });
      if (!result.ok) {
        failures.push({
          domain,
          feed: {
            id: feed.id,
            name: feed.name,
            country: feed.country,
            maintainers: feed.maintainers,
          },
          failureKind: result.failureKind,
          message: result.message,
        });
        console.warn(`[feed-liveness] DOWN: ${feed.id} — ${result.message ?? "unknown"}`);
      } else {
        console.log(`[feed-liveness] ok: ${feed.id} (${result.rowCount} rows)`);
      }
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const failures = await collectFailures();
  if (failures.length === 0) {
    console.log("[feed-liveness] all keyless feeds healthy");
    return;
  }
  await mkdir("liveness", { recursive: true });
  await writeFile(REPORT_PATH, renderReport(failures), "utf8");
  console.log(`[feed-liveness] ${failures.length} failing feed(s); wrote ${REPORT_PATH}`);
  if (process.env["GITHUB_OUTPUT"]) {
    await appendFile(process.env["GITHUB_OUTPUT"], "found=true\n");
  }
}

// Only run when invoked directly (not when a test imports collectFailures/main).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Non-gating: a dead feed must never fail the job — we report via an issue.
  main().catch((err) => {
    console.error("[feed-liveness] unexpected error (ignored, non-gating):", err);
    process.exitCode = 0;
  });
}
