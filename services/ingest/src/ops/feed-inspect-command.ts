import { Console } from "node:console";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadIngestCatalog } from "../domains.js";
import { indexFeed, inspectFeed, MAX_INSPECT_BYTES } from "./feed-inspect.js";

const USAGE =
  "usage: inspect-feed <source> --at <ISO timestamp with offset> --payload <file> [--payload <file> ...] [--id <exact situation ID> | --list] [--feeds-dir <local catalogue directory>]";

/** Read regular local files with an aggregate bound, even if they grow after stat. */
async function readPayloads(paths: readonly string[]): Promise<Buffer[]> {
  if (paths.length > 64) throw new Error("inspection accepts at most 64 payload files");
  let total = 0;
  const buffers: Buffer[] = [];
  for (const path of paths) {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error(`payload must be a regular file: ${path}`);
      const chunks: Buffer[] = [];
      const stream = file.createReadStream({ autoClose: false });
      try {
        for await (const chunk of stream) {
          total += chunk.length;
          if (total > MAX_INSPECT_BYTES)
            throw new Error("captured payloads exceed the 32 MiB inspection limit");
          chunks.push(chunk);
        }
      } finally {
        stream.destroy();
      }
      buffers.push(Buffer.concat(chunks));
    } finally {
      await file.close();
    }
  }
  return buffers;
}

/** Source-checkout developer tool; JSON goes to stdout, errors to stderr. */
export async function runFeedInspectCommand(
  args: readonly string[],
  out: (s: string) => void,
  error: (s: string) => void,
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        at: { type: "string" },
        payload: { type: "string", multiple: true },
        id: { type: "string" },
        list: { type: "boolean" },
        "feeds-dir": { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      error(USAGE);
      return 0;
    }
    if (
      positionals.length !== 1 ||
      !values.at ||
      !values.payload?.length ||
      (values.list && values.id !== undefined)
    ) {
      error(USAGE);
      return 2;
    }
    // Deliberately do not inherit process.env: remote catalogue acquisition and
    // production credentials are irrelevant to a local payload inspection.
    if (values["feeds-dir"] !== undefined && !(await stat(values["feeds-dir"])).isDirectory()) {
      throw new Error("--feeds-dir must name an existing local catalogue directory");
    }
    const catalog = await loadIngestCatalog(
      values["feeds-dir"] ? { OPENCONDITIONS_FEEDS_DIR: values["feeds-dir"] } : {},
    );
    const feed = [...catalog.feeds, ...catalog.discovered, ...catalog.disabled].find(
      (f) => f.id === positionals[0],
    );
    if (!feed) throw new Error(`no local catalogue feed ${positionals[0]}`);
    const payloads = await readPayloads(values.payload);
    const report = values.list
      ? indexFeed(feed, payloads, values.at)
      : inspectFeed(feed, payloads, values.at, values.id === undefined ? {} : { id: values.id });
    out(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // This executable owns its process. Legacy parsers use console.debug/log;
  // keep all diagnostics off the machine-readable JSON stream. Library callers
  // retain their own console; importing this module never changes global state.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  process.exitCode = await runFeedInspectCommand(
    process.argv.slice(2),
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(`${s}\n`),
  );
}
