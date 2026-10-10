/** A job the boot runs in the background: the fusion refresh, the federation reconcile. */
export interface BackgroundJob {
  /** Stops the job before its next batch. */
  stop(): void;
  /** Settles once the job has ended, whatever its outcome; never rejects. */
  done: Promise<void>;
}

/**
 * Work the service starts while it runs and shutdown waits for: the feed
 * polls the scheduler runs, and the on-demand cell fetches a read leaves
 * running past its deadline. Nothing new starts once the timers stop and the
 * server closes, so there is nothing to stop.
 */
export class InFlight implements BackgroundJob {
  readonly #running = new Set<Promise<void>>();

  /** Tracks `work` until it settles, and returns it. */
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.#running.add(settled);
    void settled.then(() => this.#running.delete(settled));
    return work;
  }

  stop(): void {}

  /** Settles once no tracked work runs, work tracked while it waits included. */
  get done(): Promise<void> {
    return (async () => {
      while (this.#running.size > 0) await Promise.all(this.#running);
    })();
  }
}

/**
 * How long shutdown waits for the background jobs and the work in flight,
 * once the server has closed, before it closes the database: inside the
 * 10 s a container runtime grants by default between its stop signal and a
 * kill. Work still running then fails its writes and is resumed on the next
 * boot (a poll attempt is closed, a cell's claim lapses).
 */
export const SHUTDOWN_BUDGET_MS = 8000;

export interface ServiceParts {
  /** Stops the timers: scheduler, record jobs, telemetry, limiter. */
  stop: readonly (() => void)[];
  background: readonly BackgroundJob[];
  app: { close(): Promise<unknown> };
  /** The connection pools, closed last. */
  databases: readonly { end(): Promise<unknown> }[];
  /** Default {@link SHUTDOWN_BUDGET_MS}. */
  budgetMs?: number;
}

/**
 * Shuts the service down: timers first, then the background jobs are asked
 * to stop before their next batch, the server closes (ending its live
 * streams), the batches and the work in flight finish (for at most the
 * budget), and the database closes last, so a stopped job ends stopped
 * rather than failed; a batch the budget cuts short is logged as stopped at
 * shutdown.
 */
export async function shutdown(parts: ServiceParts): Promise<void> {
  for (const stop of parts.stop) stop();
  for (const job of parts.background) job.stop();
  await parts.app.close();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, parts.budgetMs ?? SHUTDOWN_BUDGET_MS);
  });
  try {
    await Promise.race([Promise.all(parts.background.map((job) => job.done)), budget]);
  } finally {
    clearTimeout(timer);
  }
  for (const database of parts.databases) await database.end();
}

/**
 * The service's stop signal handler: shuts down on the first call and does
 * nothing on the next ones (a second signal), each call settling with the
 * first shutdown. A failure is logged, never rejected.
 */
export function onceShutdown(
  parts: ServiceParts,
  log: Pick<Console, "error"> = console,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () =>
    (closing ??= shutdown(parts).catch((err: unknown) => {
      log.error("[ingest] shutdown failed:", err);
    }));
}
