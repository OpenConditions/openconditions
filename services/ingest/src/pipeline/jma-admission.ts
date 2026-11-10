import { createHash } from "node:crypto";
import {
  applyJmaAreaReports,
  assertJmaRights,
  type JmaAreaState,
  type JmaReport,
  JmaRightsError,
  jmaUnit,
} from "@openconditions/hazards";

export type JmaWithheld = Record<string, { controlAt: string; hash: string }>;

/** Keep restricted bytes out of lifecycle/public state while remembering their revision floor. */
export function admitJmaWarnings(
  previous: JmaAreaState,
  withheld: JmaWithheld,
  reports: readonly JmaReport[],
): { native: JmaAreaState; withheld: JmaWithheld } {
  let native = previous;
  const next = structuredClone(withheld);
  const classified = reports
    .filter((r) => r.operational)
    .map((report) => {
      try {
        assertJmaRights(report);
        return { report, admitted: true };
      } catch (error) {
        if (!(error instanceof JmaRightsError)) throw error;
        return { report, admitted: false };
      }
    });
  // Establish every withheld floor before admitting any revision of that unit.
  classified.sort((a, b) => Date.parse(a.report.controlAt) - Date.parse(b.report.controlAt));
  for (const { report, admitted } of classified) {
    if (admitted) continue;
    const key = jmaUnit(report);
    const floor = next[key];
    if (!floor || Date.parse(report.controlAt) > Date.parse(floor.controlAt))
      next[key] = {
        controlAt: report.controlAt,
        hash: createHash("sha256").update(report.nativeXml).digest("hex"),
      };
  }
  for (const { report, admitted } of classified) {
    if (!admitted) continue;
    const key = jmaUnit(report);
    const floor = next[key];
    if (floor && Date.parse(report.controlAt) <= Date.parse(floor.controlAt)) continue;
    native = applyJmaAreaReports(native, [report]);
  }
  return { native, withheld: next };
}
