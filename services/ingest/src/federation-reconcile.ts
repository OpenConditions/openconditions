import type {
  FederationReconcileCounts,
  FederationReconcileOptions,
} from "@openconditions/storage";
import type { BackgroundJob } from "./shutdown.js";

/** The reconcile the boot runs, given its stop signal and progress callbacks. */
export type FederationReconcile = (
  opts: Pick<FederationReconcileOptions, "signal" | "onStart" | "onBatch">,
) => Promise<FederationReconcileCounts>;

/** How often, at most, progress is logged. */
const PROGRESS_EVERY_MS = 30_000;
/** How many source ids the start line names before counting the rest. */
const LISTED_SOURCES = 10;

/**
 * Runs the boot's reconcile of the federation outbox (`reconcileFederation`)
 * in the background and logs it: the sources whose `restricted` flag the
 * outbox does not reflect (the first ten), progress at most every 30 s, then
 * the outcome; nothing when every source is in sync. A failure is logged,
 * not thrown: the service keeps serving, the outbox keeps withholding a
 * now-restricted source's earlier changes, and the next boot resumes where
 * this one left off.
 */
export function startFederationReconcile(
  reconcile: FederationReconcile,
  log: Pick<Console, "info" | "error"> = console,
): BackgroundJob {
  const stop = new AbortController();
  const started = Date.now();
  let logged = 0;
  const done = reconcile({
    signal: stop.signal,
    onStart: ({ sources }) => {
      if (sources.length === 0) return;
      const listed = sources.slice(0, LISTED_SOURCES);
      const more = sources.length - listed.length;
      log.info(
        `[ingest] federation outbox outdated for ${sources.length} source(s) ` +
          `(${[...listed, ...(more > 0 ? [`+${more} more`] : [])].join(", ")}): reconciling`,
      );
    },
    onBatch: ({ source, journalled }) => {
      if (Date.now() - logged < PROGRESS_EVERY_MS) return;
      logged = Date.now();
      log.info(`[ingest] federation reconcile: ${journalled} entries journalled (${source})`);
    },
  }).then(
    (c) => {
      if (c.sources.length === 0) return;
      const outcome = c.settled.length < c.sources.length ? "stopped" : "done";
      log.info(
        `[ingest] federation reconcile ${outcome} in ${Math.round((Date.now() - started) / 1000)}s: ` +
          `${c.journalled} entries journalled; ` +
          `${c.settled.length}/${c.sources.length} source(s) settled`,
      );
    },
    (err: unknown) => {
      // Once stopped, a batch fails only because shutdown closed the database under it.
      if (stop.signal.aborted) {
        log.info(
          "[ingest] federation reconcile stopped at shutdown; the next boot resumes it:",
          (err as Error)?.message ?? err,
        );
        return;
      }
      log.error("[ingest] federation reconcile failed; the next boot resumes it:", err);
    },
  );
  return { stop: () => stop.abort(), done };
}
