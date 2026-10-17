import { type ChildProcess, fork } from "node:child_process";
import {
  type CatalogFeed,
  emptyParseOutput,
  type ParseContext,
  type ParseOutput,
  type RecordDraft,
  type SkipCounts,
} from "@openconditions/ingest-framework";
import { LARGE_PAYLOAD_BYTES } from "./parse-gate.js";
import type { SnapshotInspection } from "./snapshot-inspection.js";

/** A payload as the child receives it: as fetched, or gzipped as held. */
export interface ChildPayload {
  data: Uint8Array;
  gzipped: boolean;
}

/** One parse handed to the child. */
export interface ParseTask {
  feed: CatalogFeed;
  payloads: Readonly<Record<string, readonly ChildPayload[]>>;
  ctx: ParseContext;
}

/** What the child parsed, and what the inline path learns beside the parse. */
export interface ParsedApart {
  output: ParseOutput;
  inspection: SnapshotInspection;
  /** What the parser left unread, by reason. */
  skipped: SkipCounts;
}

/** The record classes of a parse, in the order the child sends them. */
export const RECORD_CLASSES = ["situations", "features", "observations", "offers"] as const;

/** How long an idle child stays for the next parse. */
const IDLE_MS = 60_000;

/** What the child sends back for a task: its records in slices, then how it ended. */
export type ChildMessage =
  | { type: "records"; cls: (typeof RECORD_CLASSES)[number]; records: RecordDraft[] }
  | {
      type: "done";
      /** The parse's other fields: its accounting, rejections and status index. */
      rest: Partial<ParseOutput>;
      inspection: SnapshotInspection;
      skipped: SkipCounts;
    }
  | { type: "failed"; stage: "payloads" | "parse"; message: string };

/**
 * A parse that failed: in reading its payloads (`payloads`, which the inline
 * path treats as a failed fetch) or in the parse itself (`parse`), the
 * child's death included.
 */
export class ParseProcessError extends Error {
  constructor(
    readonly stage: "payloads" | "parse",
    message: string,
  ) {
    super(message);
    this.name = "ParseProcessError";
  }
}

/**
 * Parses large payloads in a child process, one at a time. A national
 * register's parse is seconds of synchronous work and gigabytes of heap: on
 * the main thread it stalls every other poll, the API and the healthcheck,
 * and a parse that outgrows the heap takes the service down with it.
 */
export interface ParseProcess {
  /** The bytes a poll's payloads reach for it to be parsed here; a smaller one parses inline. */
  readonly minBytes: number;
  /** Whether a child is running: from a parse until a minute (`idleMs`) after the last. */
  readonly running: boolean;
  parse(task: ParseTask): Promise<ParsedApart>;
  /** Stops the child; a parse under way fails. */
  close(): Promise<void>;
}

/** The child's heap ceiling in MB, `OPENCONDITIONS_PARSE_HEAP_MB`; unset, 30% of the container's memory. */
export function parseHeapMbFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env["OPENCONDITIONS_PARSE_HEAP_MB"];
  const mb = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(mb) && mb > 0 ? mb : undefined;
}

/**
 * The child's heap option. 30% of the memory V8 sees (the container's limit,
 * else the machine's) holds a national register's parse, about 1.8 GB for
 * NDW's, under the smallest container the service supports, 6 GB; with the
 * service's own 55% both heaps fit the limit.
 */
function heapOption(heapMb: number | undefined): string {
  return heapMb === undefined
    ? "--max-old-space-size-percentage=30"
    : `--max-old-space-size=${heapMb}`;
}

/** The child's script: the bundle's beside the entry, or the source run through tsx. */
function childEntry(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("./parse-child.ts", import.meta.url)
    : new URL("./parse-child.js", import.meta.url);
}

/**
 * Starts the child on first use and again after one dies. Its heap has a
 * ceiling of its own (`heapMb`, else {@link parseHeapMbFromEnv}), so a parse
 * that outgrows its heap ends the child alone. It inherits none of the
 * service's `NODE_OPTIONS`: V8 takes a heap percentage there over the
 * child's own size, whichever comes last. An idle child does not keep the
 * service alive, and stops `idleMs` after its last parse. A poll is parsed
 * here from `minBytes`, by default the size the parse gate serializes.
 * `entry` replaces the child's script; tests only.
 */
export function createParseProcess(
  opts: { heapMb?: number; minBytes?: number; idleMs?: number; entry?: URL } = {},
): ParseProcess {
  const heap = heapOption(opts.heapMb ?? parseHeapMbFromEnv());
  const entry = opts.entry ?? childEntry();
  let child: ChildProcess | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  const idle = (c: ChildProcess) => {
    c.unref();
    c.channel?.unref();
  };
  const spawn = (): ChildProcess => {
    const c = fork(entry, {
      execArgv: [...(entry.pathname.endsWith(".ts") ? ["--import", "tsx"] : []), heap],
      env: { ...process.env, NODE_OPTIONS: "" },
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    idle(c);
    return c;
  };

  const runOne = (task: ParseTask): Promise<ParsedApart> => {
    if (closed)
      return Promise.reject(new ParseProcessError("parse", "the parse process is closed"));
    child ??= spawn();
    const c = child;
    return new Promise((resolve, reject) => {
      const output = emptyParseOutput();
      const settle = () => {
        c.off("message", onMessage);
        c.off("error", onError);
        c.off("exit", onExit);
        idle(c);
      };
      const onMessage = (message: ChildMessage) => {
        if (message.type === "records") {
          const list = output[message.cls];
          for (const record of message.records) list.push(record);
          return;
        }
        settle();
        if (message.type === "failed") {
          reject(new ParseProcessError(message.stage, message.message));
          return;
        }
        resolve({
          output: { ...output, ...message.rest },
          inspection: message.inspection,
          skipped: message.skipped,
        });
      };
      const died = (reason: string) => {
        settle();
        if (child === c) child = undefined;
        reject(new ParseProcessError("parse", `the parse process ${reason}`));
      };
      const onError = (err: Error) => {
        died(`failed: ${err.message}`);
        c.kill();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        died(signal === null ? `exited with code ${code}` : `was killed by ${signal}`);
      c.on("message", onMessage);
      c.on("error", onError);
      c.on("exit", onExit);
      c.ref();
      c.channel?.ref();
      c.send(task);
    });
  };

  // An idle child goes: the heap of a register's parse stays with the
  // process, and the next large poll is minutes away.
  const idleMs = opts.idleMs ?? IDLE_MS;
  let pending = 0;
  let retire: NodeJS.Timeout | undefined;
  const retireWhenIdle = () => {
    if (--pending > 0) return;
    retire = setTimeout(() => {
      const c = child;
      child = undefined;
      c?.kill();
    }, idleMs);
    retire.unref();
  };

  return {
    minBytes: opts.minBytes ?? LARGE_PAYLOAD_BYTES,
    get running() {
      return child !== undefined;
    },
    parse(task) {
      pending++;
      clearTimeout(retire);
      const run = queue.then(() => runOne(task)).finally(retireWhenIdle);
      // The queue waits for a parse, not for its records: holding them would
      // keep a register's drafts until the next parse.
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    async close() {
      closed = true;
      clearTimeout(retire);
      const c = child;
      child = undefined;
      if (c === undefined || c.exitCode !== null || c.signalCode !== null) return;
      const exited = new Promise((resolve) => c.once("exit", resolve));
      // An idle child is unreferenced: hold the service until it is gone.
      c.ref();
      c.kill();
      await exited;
    },
  };
}
