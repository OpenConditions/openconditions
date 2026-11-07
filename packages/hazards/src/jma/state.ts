import type { JmaReport } from "./report.js";
export type JmaState = Record<string, JmaReport>;
/** Product identity follows the manual's independent information unit, never Serial. */
export function jmaUnit(r: JmaReport): string {
  return JSON.stringify([
    r.family,
    r.eventId,
    r.family.startsWith("VXSE") ? "" : r.editorialOffice,
  ]);
}
/** Pure reconciliation: index absence never removes a unit; tombstones survive replay. */
export function applyJmaReports(previous: JmaState, reports: readonly JmaReport[]): JmaState {
  const next = structuredClone(previous);
  for (const r of reports) {
    if (!r.operational) continue;
    const key = jmaUnit(r),
      held = next[key];
    if (held && Date.parse(held.controlAt) > Date.parse(r.controlAt)) continue;
    if (held && Date.parse(held.controlAt) === Date.parse(r.controlAt)) {
      if (JSON.stringify(held) !== JSON.stringify(r))
        throw new Error("JMA: conflicting same-clock report");
      continue;
    }
    next[key] = structuredClone(r);
  }
  return next;
}
