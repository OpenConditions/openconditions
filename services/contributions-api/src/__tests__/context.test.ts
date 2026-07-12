import { describe, expect, it } from "vitest";
import {
  isValidContextPart,
  publicContextString,
  redemptionContext,
  reportEpoch,
} from "../issuer/context.js";

describe("publicContextString", () => {
  it("joins purpose, taskId, epoch with colons", () => {
    expect(publicContextString({ purpose: "probe", taskId: "task-abc", epoch: "epoch-42" })).toBe(
      "probe:task-abc:epoch-42"
    );
  });

  it("substitutes '-' for a missing taskId", () => {
    expect(publicContextString({ purpose: "report", epoch: "2026-07-12" })).toBe(
      "report:-:2026-07-12"
    );
  });
});

describe("redemptionContext", () => {
  it("is a 32-byte SHA-256 digest", async () => {
    const bytes = await redemptionContext({ purpose: "report", epoch: "2026-07-12" });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
  });

  it("is deterministic for the same context", async () => {
    const a = await redemptionContext({ purpose: "report", epoch: "2026-07-12" });
    const b = await redemptionContext({ purpose: "report", epoch: "2026-07-12" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("separates purposes, tasks, and epochs", async () => {
    const base = await redemptionContext({ purpose: "report", epoch: "2026-07-12" });
    const otherPurpose = await redemptionContext({ purpose: "probe", epoch: "2026-07-12" });
    const otherEpoch = await redemptionContext({ purpose: "report", epoch: "2026-07-13" });
    const withTask = await redemptionContext({
      purpose: "report",
      taskId: "t1",
      epoch: "2026-07-12",
    });
    for (const other of [otherPurpose, otherEpoch, withTask]) {
      expect(Buffer.from(base).equals(Buffer.from(other))).toBe(false);
    }
  });
});

describe("reportEpoch", () => {
  it("is the UTC day of the given instant", () => {
    expect(reportEpoch("2026-07-12T23:59:59.999Z")).toBe("2026-07-12");
    expect(reportEpoch("2026-07-12T00:00:00.000Z")).toBe("2026-07-12");
  });
});

describe("isValidContextPart", () => {
  it("accepts simple slugs", () => {
    for (const part of ["report", "probe", "task-abc", "2026-07-12", "epoch_42"]) {
      expect(isValidContextPart(part)).toBe(true);
    }
  });

  it("rejects the colon separator and empties (no context ambiguity)", () => {
    for (const part of ["", "a:b", "report:", " ", "a b", "a\nb"]) {
      expect(isValidContextPart(part)).toBe(false);
    }
  });
});
