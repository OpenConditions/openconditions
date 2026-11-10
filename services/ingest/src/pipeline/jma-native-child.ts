import {
  assertJmaRights,
  jmaSituations,
  readJmaIndex,
  readJmaReport,
} from "@openconditions/hazards";
import { JMA_IPC_BYTES, type JmaNativeTask } from "./jma-native-process.js";
import { materializeJma, unpackJmaState } from "./jma-state-store.js";

process.on("disconnect", () => process.exit(0));
process.on("message", (input: unknown) => {
  try {
    if (typeof input !== "string" || Buffer.byteLength(input) > JMA_IPC_BYTES)
      throw new Error("JMA: native IPC input ceiling");
    const task = JSON.parse(input) as JmaNativeTask;
    process.send?.("started");
    let value: unknown;
    switch (task.kind) {
      case "index":
        value = readJmaIndex(Buffer.from(task.body, "base64"), task.families);
        break;
      case "report":
        value = readJmaReport(Buffer.from(task.body, "base64"), task.family);
        break;
      case "state":
        value = materializeJma(task);
        break;
      case "situations": {
        const state = unpackJmaState(task.state);
        for (const report of new Set([
          ...Object.values(state.native.products),
          ...Object.values(state.native.areas).map((a) => a.report),
        ]))
          assertJmaRights(report);
        value = jmaSituations(task.source, state.native, task.at);
        break;
      }
      default:
        throw new Error("JMA: unknown native task");
    }
    const message = JSON.stringify({ value });
    if (Buffer.byteLength(message) > JMA_IPC_BYTES)
      throw new Error("JMA: native IPC output ceiling");
    process.send!(message);
  } catch (error) {
    process.send!(
      JSON.stringify({ error: error instanceof Error ? error.message : "JMA: native failure" }),
    );
  }
});
