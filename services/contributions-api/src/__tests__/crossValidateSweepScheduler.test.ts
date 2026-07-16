import { describe, expect, it } from "vitest";
import { isCrossValidateSweepEnabled, singleFlight } from "../evidence/crossValidateSweep.js";

// The main.ts wiring (setInterval + clearInterval-on-close) is a thin shell over
// two extracted, deterministically testable pieces: the opt-out predicate and the
// single-flight guard. Testing those avoids a brittle real-timer test while still
// covering the scheduler's two behaviors.
describe("cross-validate sweep scheduler wiring", () => {
  it("opt-out: OPENCONDITIONS_CROSS_VALIDATE_SWEEP=off disables scheduling; anything else (incl. unset) enables it", () => {
    expect(isCrossValidateSweepEnabled({ OPENCONDITIONS_CROSS_VALIDATE_SWEEP: "off" })).toBe(false);
    expect(isCrossValidateSweepEnabled({})).toBe(true);
    expect(isCrossValidateSweepEnabled({ OPENCONDITIONS_CROSS_VALIDATE_SWEEP: "on" })).toBe(true);
    expect(isCrossValidateSweepEnabled({ OPENCONDITIONS_CROSS_VALIDATE_SWEEP: "" })).toBe(true);
  });

  it("single-flight: an overlapping tick is a no-op while the prior run is in flight", async () => {
    let running = 0;
    let maxConcurrent = 0;
    let invocations = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tick = singleFlight(async () => {
      invocations += 1;
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await gate; // hold the first run open
      running -= 1;
    });

    const first = tick(); // enters, holds the gate
    await tick(); // overlapping tick: must return immediately, NOT invoke run
    expect(invocations).toBe(1);

    release();
    await first;
    expect(maxConcurrent).toBe(1);

    // Once the prior run settles, a later tick runs normally.
    await tick();
    expect(invocations).toBe(2);
  });
});
