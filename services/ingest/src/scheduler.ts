import { Cron } from "croner";
import type postgres from "postgres";
import { DOMAIN_REGISTRY } from "./domains.js";
import { runSource } from "./pipeline/run.js";
import type { DomainFeedSource } from "./pipeline/run.js";

type Sql = postgres.Sql;

function cadenceToCron(cadenceSec: number): string {
  if (cadenceSec < 60) return `*/${cadenceSec} * * * * *`;
  const mins = Math.round(cadenceSec / 60);
  return `*/${mins} * * * *`;
}

/**
 * Starts one `croner` job per enabled feed source across all registered domains.
 * Each job holds a single-flight boolean so slow runs do not overlap.
 * Returns a cancel function that stops all scheduled jobs.
 */
export function startScheduler(sql: Sql): () => void {
  const jobs: Cron[] = [];

  for (const [domainName, plugin] of Object.entries(DOMAIN_REGISTRY)) {
    const enabled = plugin.feeds.filter((f) => f.enabledByDefault);

    for (const feed of enabled) {
      const src: DomainFeedSource = { ...feed, domain: domainName };
      const cronExpr = cadenceToCron(feed.cadenceSec);
      let running = false;

      const job = new Cron(cronExpr, { catch: true }, async () => {
        if (running) {
          console.debug(`[scheduler] ${src.id}: skipping (previous run still active)`);
          return;
        }
        running = true;
        try {
          await runSource(src, { sql, fetch, now: () => new Date().toISOString() });
        } catch (err) {
          console.error(`[scheduler] ${src.id}: unexpected error`, err);
        } finally {
          running = false;
        }
      });

      console.info(
        `[scheduler] registered ${domainName}/${src.id} every ${feed.cadenceSec}s (${cronExpr})`
      );
      jobs.push(job);
    }
  }

  return () => {
    for (const job of jobs) {
      job.stop();
    }
  };
}
