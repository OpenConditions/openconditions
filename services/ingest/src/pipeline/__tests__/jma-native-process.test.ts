import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { closeJmaNative, type JmaNativeSession, jmaNative } from "../jma-native-process.js";
import { observeOomFork } from "./jma-oom-diagnostics.js";

const small = {
  kind: "index",
  body: Buffer.from(
    '<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-09T11:00:00Z</updated></feed>',
  ).toString("base64"),
  families: [],
} as const;
const large = {
  ...small,
  body: Buffer.from(
    `<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-09T11:00:00Z</updated>${"<x/>".repeat(1_500_000)}</feed>`,
  ).toString("base64"),
};
const gone = (pid: number) => expect(() => process.kill(pid, 0)).toThrow();

test.each(["source", "bundle"])(
  "%s actual native decoder is killed and reaped on caller abort, then resets",
  async (mode) => {
    const session: JmaNativeSession =
      mode === "bundle"
        ? { entry: new URL("../../../dist/jma-native-child.js", import.meta.url) }
        : {};
    const controller = new AbortController();
    let pid = 0;
    await expect(
      jmaNative(large, controller.signal, session, (value) => {
        pid = value;
        controller.abort(new Error("controlled native cancellation"));
      }),
    ).rejects.toThrow("controlled native cancellation");
    expect(pid).toBeGreaterThan(0);
    gone(pid);
    expect(session.child).toBeUndefined();
    expect(await jmaNative(small, AbortSignal.timeout(10_000), session)).toEqual({
      updated: "2026-11-09T11:00:00Z",
      urls: [],
    });
    const nextPid = session.child!.pid!;
    await closeJmaNative(session);
    gone(nextPid);
  },
);

test("native child exit while decoding fails without accepted output and allows next task", async () => {
  const session: JmaNativeSession = {};
  let pid = 0;
  await expect(
    jmaNative(large, AbortSignal.timeout(10_000), session, (value) => {
      pid = value;
      process.kill(value, "SIGKILL");
    }),
  ).rejects.toThrow(/native child exited/);
  gone(pid);
  expect(await jmaNative(small, AbortSignal.timeout(10_000), session)).toHaveProperty("urls", []);
  await closeJmaNative(session);
});

test("native XML failure is reaped and cannot poison a later real report", async () => {
  const session: JmaNativeSession = {};
  await expect(
    jmaNative(
      { ...small, body: Buffer.from("<!DOCTYPE invalid>").toString("base64") },
      AbortSignal.timeout(10_000),
      session,
    ),
  ).rejects.toThrow(/malformed/);
  expect(session.child).toBeUndefined();
  const body = readFileSync(
    new URL(
      "../../../../../packages/hazards/src/__tests__/fixtures/jma/33_12_01_240613_VXSE52.xml",
      import.meta.url,
    ),
  ).toString("base64");
  expect(
    await jmaNative(
      { kind: "report", body, family: "VXSE52" },
      AbortSignal.timeout(10_000),
      session,
    ),
  ).toHaveProperty("family", "VXSE52");
  await closeJmaNative(session);
});

test("parent wall-clock timer interrupts actual CPU decoding after child readiness", async () => {
  const controller = new AbortController();
  let pid = 0;
  let heartbeat = false;
  await expect(
    jmaNative(large, controller.signal, undefined, (value) => {
      pid = value;
      setTimeout(() => {
        heartbeat = true;
        controller.abort(new Error("wall-clock decoder deadline"));
      }, 20);
    }),
  ).rejects.toThrow("wall-clock decoder deadline");
  expect(heartbeat).toBe(true);
  gone(pid);
});

test("actual native decoder heap exhaustion is contained and next task succeeds", async () => {
  let pid = 0;
  const session: JmaNativeSession = {
    entry: new URL("../../../dist/jma-native-child.js", import.meta.url),
  };
  const task = {
    ...large,
    body: Buffer.from(
      `<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-09T11:00:00Z</updated>${Array.from({ length: 700_000 }, (_, i) => `<x${i}/>`).join("")}</feed>`,
    ).toString("base64"),
  };
  const signal = AbortSignal.timeout(10_000);
  const diagnostics = observeOomFork(signal);
  try {
    diagnostics.record("call");
    await expect(
      jmaNative(task, signal, session, (value) => {
        pid = value;
        diagnostics.record("started-callback", { pid });
      }),
    ).rejects.toThrow(/native child exited/);
    diagnostics.record("native-exit-rejection", { pid });
    gone(pid);
    diagnostics.record("pid-gone", { pid });
    expect(await jmaNative(small, AbortSignal.timeout(10_000), session)).toHaveProperty("urls", []);
    diagnostics.record("recovery", { pid: session.child?.pid });
    expect(diagnostics.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "fork",
          pid,
          execArgv: ["--max-old-space-size=256"],
          emptyNodeOptions: true,
        }),
        expect.objectContaining({ event: "fatal-stderr", pid }),
        expect.objectContaining({ event: "exit", pid }),
      ]),
    );
  } finally {
    try {
      await closeJmaNative(session);
      diagnostics.record("closed");
    } finally {
      diagnostics.restore();
      process.stderr.write(
        `JMA synthetic OOM lifecycle ${JSON.stringify(diagnostics.snapshot())}\n`,
      );
    }
  }
});

test("IPC input ceiling refuses before any child starts", async () => {
  let started = false;
  await expect(
    jmaNative(
      { ...small, body: "x".repeat(48_000_000) },
      AbortSignal.timeout(10_000),
      undefined,
      () => {
        started = true;
      },
    ),
  ).rejects.toThrow(/IPC input ceiling/);
  expect(started).toBe(false);
});

test("concurrent native requests are refused without a pending queue and reset after abort", async () => {
  const session: JmaNativeSession = {};
  const controller = new AbortController();
  let concurrent: Promise<unknown> | undefined;
  await expect(
    jmaNative(large, controller.signal, session, () => {
      concurrent = expect(jmaNative(small, AbortSignal.timeout(10_000), session)).rejects.toThrow(
        /concurrent/,
      );
      void concurrent.then(() => controller.abort(new Error("queue-free cancellation")));
    }),
  ).rejects.toThrow("queue-free cancellation");
  await concurrent;
  expect(session.busy).toBe(false);
  expect(await jmaNative(small, AbortSignal.timeout(10_000), session)).toHaveProperty("urls", []);
  await closeJmaNative(session);
});
