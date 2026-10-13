/**
 * Times the stages of a write into `steps`, wall clock: each call ends the
 * stage under way, adding the ms since the previous call (or since the timer
 * started) to `steps[stage]`. A stage of a stage is named `<stage>/<part>`.
 * Without `steps`, it times nothing.
 */
export function stepTimer(steps: Record<string, number> | undefined): (stage: string) => void {
  let at = Date.now();
  return (stage) => {
    const now = Date.now();
    if (steps !== undefined) steps[stage] = (steps[stage] ?? 0) + now - at;
    at = now;
  };
}
