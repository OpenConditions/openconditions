import { JMA_FAMILIES, jmaSituations } from "@openconditions/hazards";
import type { CatalogFeed } from "@openconditions/ingest-framework";
import { writeSnapshotIn } from "@openconditions/storage";
import { JmaAcquisition } from "./jma-acquisition.js";
import { jmaDownloadStore } from "./jma-download-store.js";
import { type JmaPersistentState, reconcileJmaIn, unpackJmaState } from "./jma-state-store.js";
import { stampAttribution, writeContext, writeModel } from "./publish.js";
import type { RunDeps, RunResult } from "./run.js";
import { upsertSourceStatus } from "./source-status.js";

/** Dedicated rolling-report path: the generic snapshot parser cannot own JMA state. */
export async function runJma(
  src: CatalogFeed,
  deps: RunDeps,
  attempt: { id: number; at: string; closed: boolean },
): Promise<RunResult> {
  const start = Date.now();
  if (deps.raw)
    throw new Error(
      "JMA: raw archive capture is unsupported pending upstream-rights qualification",
    );
  const egress = (deps.env ?? process.env)["OPENCONDITIONS_JMA_EGRESS_ID"];
  if (!egress?.trim())
    throw new Error(
      "JMA: OPENCONDITIONS_JMA_EGRESS_ID must identify the shared provider-visible IP and database",
    );
  const warnings = src.product === "alerts";
  if (src.product !== "quakes" && !warnings) throw new Error("JMA: unsupported product");
  if (warnings && (deps.env ?? process.env)["OPENCONDITIONS_JMA_WARNING_COVERAGE"] !== "incomplete")
    throw new Error(
      "JMA: warning activation requires authoritative bootstrap qualification; coverage incomplete",
    );
  const [held] = await deps.sql<
    { value: JmaPersistentState }[]
  >`SELECT value FROM conditions.jma_state WHERE source = ${src.id}`;
  const at = Date.parse(attempt.at);
  const acquisition = new JmaAcquisition(
    jmaDownloadStore(deps.sql),
    egress,
    () => Date.parse(deps.now()),
    deps.fetch,
    deps.lookup,
  );
  const signal = AbortSignal.timeout(120_000);
  const result = await acquisition.poll(
    warnings ? "extra" : "eqvol",
    JMA_FAMILIES.filter((f) => (warnings ? f.startsWith("VPWW") : f.startsWith("VXSE"))),
    held ? unpackJmaState(held.value).lastSuccess : undefined,
    signal,
  );
  if (warnings) {
    const volcanic = await acquisition.poll(
      "eqvol",
      ["VFVO50"],
      held ? unpackJmaState(held.value).lastSuccess : undefined,
      signal,
    );
    result.reports.push(...volcanic.reports);
    result.gap ||= volcanic.gap;
    result.networkValidated &&= volcanic.networkValidated;
    result.payloadHashes.push(...volcanic.payloadHashes);
  }
  if (result.reports.some(({ report }) => Date.parse(report.controlAt) > at + 60_000))
    throw new Error("JMA: future report revision clock");
  const summary = await reconcileJmaIn(
    deps.sql,
    src.id,
    result.reports.map((r) => r.report),
    at,
    result.gap,
    async (tx, state) => {
      const drafts = jmaSituations(src, state.native, attempt.at).map((d) =>
        stampAttribution(d, src, new Date(at)),
      );
      const summary = await writeSnapshotIn(
        tx,
        src.id,
        { situations: drafts },
        writeContext({
          poll: { id: attempt.id, at: attempt.at },
          now: attempt.at,
          model: writeModel(deps.model),
        }),
      );
      if (summary.rejected.length)
        throw new Error("JMA: canonical draft validation failed; poll rolled back");
      const counts = summary.counts.situation;
      await upsertSourceStatus(tx, src.id, {
        freshnessWindowSec: src.freshnessWindowSec,
        attemptId: attempt.id,
        attemptAt: attempt.at,
        outcome: "partial",
        networkValidated: result.networkValidated,
        payloadHashes: result.payloadHashes,
        error: "JMA rolling-index coverage incomplete",
        publication: {
          activeEvents: drafts.length,
          rowCount: drafts.length,
          inserted: counts.created + counts.restored,
          updated: counts.updated,
          deleted: counts.withdrawn,
          rejected: 0,
        },
      });
      return summary;
    },
    warnings
      ? {
          source: src.id,
          at: new Date(at).toISOString(),
          coverage: "incomplete",
          method: "rolling-index-observed-reports",
          payloadHashes: result.payloadHashes,
        }
      : undefined,
  );
  attempt.closed = true;
  const c = summary.counts.situation;
  return { count: c.created + c.restored + c.updated, durationMs: Date.now() - start };
}
