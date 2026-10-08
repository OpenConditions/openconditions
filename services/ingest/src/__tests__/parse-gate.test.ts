import { describe, expect, it } from "vitest";
import { createParseGate, LARGE_PAYLOAD_BYTES, payloadBytes } from "../pipeline/parse-gate.js";

/** A task that records when it starts and finishes, and ends when told to. */
function controlled(name: string, log: string[]) {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    finish,
    task: async () => {
      log.push(`${name} start`);
      await done;
      log.push(`${name} end`);
      return name;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("createParseGate", () => {
  it("runs one large payload's parse and write at a time, in arrival order", async () => {
    const gate = createParseGate(100);
    const log: string[] = [];
    const a = controlled("a", log);
    const b = controlled("b", log);
    const c = controlled("c", log);

    const ra = gate.run(100, a.task);
    const rb = gate.run(500, b.task);
    const rc = gate.run(100, c.task);
    await flush();
    expect(log).toEqual(["a start"]);

    a.finish();
    await flush();
    expect(log).toEqual(["a start", "a end", "b start"]);

    b.finish();
    c.finish();
    await expect(Promise.all([ra, rb, rc])).resolves.toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  it("lets a small payload through while a large one holds the gate", async () => {
    const gate = createParseGate(100);
    const log: string[] = [];
    const large = controlled("large", log);
    const small = controlled("small", log);

    const rl = gate.run(1_000, large.task);
    const rs = gate.run(99, small.task);
    await flush();
    expect([...log].sort()).toEqual(["large start", "small start"]);

    small.finish();
    large.finish();
    await expect(Promise.all([rl, rs])).resolves.toEqual(["large", "small"]);
  });

  it("frees the gate when a task fails", async () => {
    const gate = createParseGate(100);
    const failing = gate.run(100, async () => {
      throw new Error("parse failed");
    });
    await expect(failing).rejects.toThrow("parse failed");
    await expect(gate.run(100, async () => "next")).resolves.toBe("next");
  });

  it("frees the gate when a task throws before it awaits", async () => {
    const gate = createParseGate(100);
    const failing = gate.run(100, () => {
      throw new Error("sync parse failure");
    });
    await expect(failing).rejects.toThrow("sync parse failure");
    await expect(gate.run(100, async () => "next")).resolves.toBe("next");
  });

  it("defaults to the large-payload threshold", async () => {
    const gate = createParseGate();
    const log: string[] = [];
    const held = controlled("held", log);
    const below = controlled("below", log);
    const rh = gate.run(LARGE_PAYLOAD_BYTES, held.task);
    const rb = gate.run(LARGE_PAYLOAD_BYTES - 1, below.task);
    await flush();
    expect([...log].sort()).toEqual(["below start", "held start"]);
    held.finish();
    below.finish();
    await Promise.all([rh, rb]);
  });
});

describe("createParseGate: waits", () => {
  it("reports how long a large payload waited for the gate, by the label it named", async () => {
    let clock = 0;
    const waits: [string, number][] = [];
    const gate = createParseGate(100, {
      now: () => clock,
      onWait: (label, ms) => waits.push([label, ms]),
    });
    const log: string[] = [];
    const a = controlled("a", log);
    const ra = gate.run(100, a.task, "fr-irve-charging");
    const rb = gate.run(100, async () => "b", "nl-ndw-charging");
    await flush();
    clock = 42_000;
    a.finish();
    await Promise.all([ra, rb]);
    expect(waits).toEqual([
      ["fr-irve-charging", 0],
      ["nl-ndw-charging", 42_000],
    ]);
  });
});

describe("payloadBytes", () => {
  it("sums every buffer of every role", () => {
    expect(
      payloadBytes({
        main: [Buffer.alloc(3), Buffer.alloc(4)],
        status: [Buffer.alloc(5)],
        none: [],
      }),
    ).toBe(12);
  });
});
