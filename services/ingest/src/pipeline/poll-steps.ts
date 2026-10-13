/**
 * How long each step of one poll took, wall clock: what a slow poll spent
 * its time on. Each `lap` ends the step under way, so the steps add up to
 * the poll's duration.
 */
export class PollSteps {
  readonly ms: Record<string, number> = {};
  /** The stages of the poll's write, as its writer timed them. */
  writeMs: Record<string, number> = {};
  private lapStart: number;

  constructor(
    start: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.lapStart = start;
  }

  /** Ends the step under way as `step`; a step lapped twice adds up. */
  lap(step: string): void {
    const now = this.clock();
    this.ms[step] = (this.ms[step] ?? 0) + now - this.lapStart;
    this.lapStart = now;
  }

  /** `fetch 1.2s, parse 8.0s, write 48.1s (features 3.0s, readings 40.2s)`: steps under 50 ms left out. */
  describe(): string {
    const list = (ms: Record<string, number>) =>
      Object.entries(ms)
        .filter(([, n]) => n >= 50)
        .map(([step, n]) => `${step} ${(n / 1000).toFixed(1)}s`)
        .join(", ");
    const write = list(this.writeMs);
    return Object.entries(this.ms)
      .filter(([, n]) => n >= 50)
      .map(([step, n]) => {
        const own = `${step} ${(n / 1000).toFixed(1)}s`;
        return step === "write" && write !== "" ? `${own} (${write})` : own;
      })
      .join(", ");
  }
}
