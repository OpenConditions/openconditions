import {
  drainSkipped,
  type FeedPayloads,
  heldBuffers,
  type ParseOutput,
} from "@openconditions/ingest-framework";
import { formatOf } from "../domains.js";
import { type ChildMessage, type ParseTask, RECORD_CLASSES } from "./parse-process.js";
import { inspectSnapshotCompleteness, type SnapshotInspection } from "./snapshot-inspection.js";

/**
 * Records one message carries back. The service reads each message in a turn
 * of its own, so a national register's drafts never hold its event loop at once.
 */
const RECORDS_PER_MESSAGE = 2000;

const post = (message: ChildMessage) => process.send!(message);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

process.on("message", (task: ParseTask) => {
  void parse(task);
});
// The service went away: nothing is left to parse for.
process.on("disconnect", () => process.exit(0));

/** A task's payloads as fetched: the child gunzips the held ones. */
async function payloadsOf(task: ParseTask): Promise<FeedPayloads> {
  const roles = await Promise.all(
    Object.entries(task.payloads).map(async ([role, list]) => {
      const held = list.map((p) => ({
        data: Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength),
        gzipped: p.gzipped,
        bytes: p.data.byteLength,
      }));
      return [role, await heldBuffers(held)] as const;
    }),
  );
  return Object.fromEntries(roles);
}

/** Parses one task as the poll's inline path would, and sends the result back in slices. */
async function parse(task: ParseTask): Promise<void> {
  const { feed } = task;
  let payloads: FeedPayloads;
  let inspection: SnapshotInspection;
  try {
    payloads = await payloadsOf(task);
    inspection = inspectSnapshotCompleteness(feed, payloads["main"] ?? []);
  } catch (err) {
    post({ type: "failed", stage: "payloads", message: messageOf(err) });
    return;
  }
  let output: ParseOutput;
  try {
    output = formatOf(feed).parse(feed, payloads, task.ctx);
  } catch (err) {
    drainSkipped(feed.id);
    post({ type: "failed", stage: "parse", message: messageOf(err) });
    return;
  }
  for (const cls of RECORD_CLASSES) {
    const records = output[cls];
    // A slice is serialized as it is sent: dropping it here frees its drafts
    // while the service still reads, so the two never hold them all at once.
    output[cls] = [];
    for (let i = 0; i < records.length; i += RECORDS_PER_MESSAGE) {
      post({ type: "records", cls, records: records.slice(i, i + RECORDS_PER_MESSAGE) });
      records.fill(undefined as never, i, i + RECORDS_PER_MESSAGE);
    }
  }
  const rest: Partial<ParseOutput> = { ...output };
  for (const cls of RECORD_CLASSES) delete rest[cls];
  post({ type: "done", rest, inspection, skipped: drainSkipped(feed.id) });
}
