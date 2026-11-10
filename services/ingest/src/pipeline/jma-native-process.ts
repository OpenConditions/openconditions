import { type ChildProcess, fork } from "node:child_process";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { JmaFamily, JmaReport, jmaSituations, readJmaIndex } from "@openconditions/hazards";
import type { CatalogFeed } from "@openconditions/ingest-framework";
import type {
  JmaInitializationReceipt,
  JmaPersistentState,
  PackedState,
} from "./jma-state-store.js";

export type JmaNativeTask =
  | { kind: "index"; body: string; families: readonly JmaFamily[] }
  | { kind: "report"; body: string; family: JmaFamily }
  | {
      kind: "state";
      source: string;
      previous?: JmaPersistentState | PackedState;
      reports: readonly JmaReport[];
      at: number;
      gap: boolean;
      initialization?: JmaInitializationReceipt;
      warnings: boolean;
    }
  | { kind: "situations"; state: PackedState; source: CatalogFeed; at: string };
type Result<T extends JmaNativeTask> = T extends { kind: "index" }
  ? ReturnType<typeof readJmaIndex>
  : T extends { kind: "report" }
    ? JmaReport
    : T extends { kind: "state" }
      ? PackedState
      : ReturnType<typeof jmaSituations>;
export const JMA_IPC_BYTES = 48_000_000;

export interface JmaNativeSession {
  child?: ChildProcess;
  entry?: URL;
  busy?: boolean;
}
export async function closeJmaNative(session: JmaNativeSession): Promise<void> {
  const child = session.child;
  session.child = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

/** Serial session reuse amortizes startup; abort/error always reaps before settling. No task queue. */
export async function jmaNative<T extends JmaNativeTask>(
  task: T,
  caller: AbortSignal,
  session?: JmaNativeSession,
  started?: (pid: number) => void,
): Promise<Result<T>> {
  await yieldTurn();
  caller.throwIfAborted();
  const signal = AbortSignal.any([caller, AbortSignal.timeout(120_000)]);
  const input = JSON.stringify(task);
  if (Buffer.byteLength(input) > JMA_IPC_BYTES) throw new Error("JMA: native IPC input ceiling");
  signal.throwIfAborted();
  const entry =
    session?.entry ??
    new URL(
      import.meta.url.endsWith(".ts") ? "./jma-native-child.ts" : "./jma-native-child.js",
      import.meta.url,
    );
  if (session?.busy) throw new Error("JMA: concurrent native task refused");
  if (session) session.busy = true;
  try {
    return await new Promise<Result<T>>((resolve, reject) => {
      const child =
        session?.child ??
        fork(entry, {
          execArgv: [
            ...(entry.pathname.endsWith(".ts") ? ["--import", "tsx"] : []),
            "--max-old-space-size=256",
          ],
          env: { ...process.env, NODE_OPTIONS: "" },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
      if (session && session.child !== child) {
        session.child = child;
        child.once("exit", () => {
          if (session.child === child) session.child = undefined;
        });
      }
      child.ref();
      child.channel?.ref();
      let output: Result<T> | undefined;
      let error: unknown;
      let received = false;
      const abort = () => {
        error = signal.reason;
        child.kill("SIGKILL");
      };
      signal.addEventListener("abort", abort, { once: true });
      const onError = (err: Error) => {
        error = err;
        child.kill("SIGKILL");
      };
      const onMessage = (message: unknown) => {
        if (message === "started") {
          started?.(child.pid!);
          return;
        }
        if (received) {
          error = new Error("JMA: duplicate native response");
          child.kill("SIGKILL");
          return;
        }
        received = true;
        try {
          if (typeof message !== "string" || Buffer.byteLength(message) > JMA_IPC_BYTES)
            throw new Error("JMA: native IPC output ceiling");
          const result = JSON.parse(message) as { value?: Result<T>; error?: string };
          if (result.error) throw new Error(result.error);
          output = result.value;
        } catch (err) {
          error = err;
        }
        if (!error && output !== undefined && session && !signal.aborted) {
          cleanup();
          resolve(output);
        } else child.kill("SIGKILL");
      };
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onExit = (code: number | null, why: NodeJS.Signals | null) => {
        cleanup();
        if (session) session.child = undefined;
        signal.removeEventListener("abort", abort);
        if (signal.aborted) error = signal.reason;
        if (error) reject(error);
        else if (!received || output === undefined)
          reject(new Error(`JMA: native child exited ${code}/${why}`));
        else resolve(output);
      };
      child.on("error", onError);
      child.on("message", onMessage);
      child.once("exit", onExit);
      if (signal.aborted) abort();
      else
        child.send(input, (err) => {
          if (err) {
            error = err;
            child.kill("SIGKILL");
          }
        });
    });
  } finally {
    if (session) session.busy = false;
  }
}
