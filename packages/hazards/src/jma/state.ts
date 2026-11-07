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

export interface JmaAreaState {
  /** Includes explicit releases, so old messages cannot resurrect an area after restart. */
  areas: Record<
    string,
    { report: JmaReport; warning: JmaReport["warnings"][number]; ended: boolean }
  >;
  products: JmaState;
}
export function jmaAreaUnit(report: JmaReport, warning: JmaReport["warnings"][number]): string {
  return JSON.stringify([
    report.family,
    report.eventId,
    report.editorialOffice,
    warning.system,
    warning.product,
    warning.area,
  ]);
}
/** Warning code is a level within the stable product/area unit, never its identity. */
export function applyJmaAreaReports(
  previous: JmaAreaState,
  reports: readonly JmaReport[],
): JmaAreaState {
  const next = structuredClone(previous);
  // Validate all equal-clock conflicts before mutating any area, including omitted areas.
  applyJmaReports(next.products, reports);
  for (const report of [...reports].sort(
    (a, b) => Date.parse(a.controlAt) - Date.parse(b.controlAt),
  )) {
    next.products = applyJmaReports(next.products, [report]);
    if (!report.operational || report.family.startsWith("VXSE")) continue;
    const latest = next.products[jmaUnit(report)];
    if (!latest || Date.parse(latest.controlAt) > Date.parse(report.controlAt)) continue;
    if (report.cancelled)
      throw new Error("JMA: warning cancellation requires native product-specific reconciliation");
    for (const warning of report.warnings) {
      const key = jmaAreaUnit(report, warning);
      const held = next.areas[key];
      if (held && Date.parse(held.report.controlAt) > Date.parse(report.controlAt)) continue;
      const ended =
        warning.status === "解除" ||
        warning.status === "発表警報・注意報はなし" ||
        warning.code === "00" ||
        (report.family === "VFVO50" && warning.system === "火山名" && warning.code === "11");
      if (
        held &&
        held.report.controlAt === report.controlAt &&
        JSON.stringify(held.warning) !== JSON.stringify(warning)
      )
        throw new Error("JMA: conflicting area in one revision");
      next.areas[key] = {
        report: structuredClone(report),
        warning: structuredClone(warning),
        ended,
      };
    }
  }
  return next;
}
