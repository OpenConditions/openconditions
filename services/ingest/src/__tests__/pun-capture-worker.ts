import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Qualification instrumentation around the unchanged real parse-child protocol and heap policy.
const send = process.send;
if (!send || !process.env["PUN_CAPTURE_DIR"])
  throw Error("PUN worker probe needs IPC and capture directory");
process.send = ((message: unknown, ...args: unknown[]) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "done"
  )
    writeFileSync(
      join(process.env["PUN_CAPTURE_DIR"]!, "worker-resources.json"),
      JSON.stringify(
        {
          pid: process.pid,
          resourceUsage: process.resourceUsage(),
          memory: process.memoryUsage(),
          execArgv: process.execArgv,
        },
        null,
        2,
      ),
    );
  return Reflect.apply(send, process, [message, ...args]);
}) as typeof process.send;
await import("../pipeline/parse-child.js");
