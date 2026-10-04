import type { OutdatedRefreshCounts, OutdatedRefreshOptions } from "@openconditions/storage";
import type { BackgroundJob } from "./shutdown.js";

/** The refresh the boot runs, given its stop signal and progress callbacks. */
export type OutdatedRefresh = (
  opts: Pick<OutdatedRefreshOptions, "signal" | "onStart" | "onBatch">,
) => Promise<OutdatedRefreshCounts>;

/** How often, at most, progress is logged. */
const PROGRESS_EVERY_MS = 30_000;
/** How many outdated source ids the start line names before counting the rest. */
const LISTED_SOURCES = 10;

/**
 * Runs the boot's refresh of outdated fusions (`refreshOutdatedFusions`) in
 * the background and logs it: the outdated sources (the first ten) and how
 * many canonical features they touch, progress at most every 30 s, then the
 * outcome; nothing when no canonical feature needs refreshing. A
 * failure is logged, not thrown: the service keeps serving, the read-time
 * check on `fused_sources` keeps withholding a public fused reading a
 * now-restricted source contributed to, and the next boot resumes where this
 * one left off.
 */
export function startFusedRefresh(
  refresh: OutdatedRefresh,
  log: Pick<Console, "info" | "error"> = console,
): BackgroundJob {
  const stop = new AbortController();
  const started = Date.now();
  let logged = 0;
  const done = refresh({
    signal: stop.signal,
    onStart: ({ sources, total }) => {
      if (total === 0) return;
      const listed = sources.slice(0, LISTED_SOURCES);
      const more = sources.length - listed.length;
      log.info(
        `[ingest] fusions outdated for ${sources.length} source(s) ` +
          `(${[...listed, ...(more > 0 ? [`+${more} more`] : [])].join(", ")}): ` +
          `refreshing ${total} canonical feature(s)`,
      );
    },
    onBatch: ({ done, total }) => {
      if (Date.now() - logged < PROGRESS_EVERY_MS) return;
      logged = Date.now();
      log.info(`[ingest] fusion refresh: ${done}/${total} canonical features`);
    },
  }).then(
    (c) => {
      if (c.total === 0) return;
      const outcome = c.settled.length < c.sources.length ? "stopped" : "done";
      log.info(
        `[ingest] fusion refresh ${outcome} in ${Math.round((Date.now() - started) / 1000)}s: ` +
          `${c.features}/${c.total} canonical features, ${c.written} written, ` +
          `${c.unchanged} unchanged, ${c.deleted} deleted; ` +
          `${c.settled.length}/${c.sources.length} source(s) settled`,
      );
    },
    (err: unknown) => {
      // Once stopped, a batch fails only because shutdown closed the database under it.
      if (stop.signal.aborted) {
        log.info(
          "[ingest] fusion refresh stopped at shutdown; the next boot resumes it:",
          (err as Error)?.message ?? err,
        );
        return;
      }
      log.error("[ingest] fusion refresh failed; the next boot resumes it:", err);
    },
  );
  return { stop: () => stop.abort(), done };
}
