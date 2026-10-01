import type { SituationClass } from "@openconditions/model";
import { hazardsCrosswalk } from "./module.js";
import { CAP_CP_EVENTS } from "./vocabularies/cap-events.js";

/** A CAP `eventCode` or `parameter`: a named value. */
export interface CapPair {
  valueName: string;
  value: string;
}

const CAP_CP_CODES = new Map(Object.keys(CAP_CP_EVENTS).map((c) => [c.toLowerCase(), c]));

/** `/O.CON.KICT.TO.W.0030.000000T0000Z-261001T0000Z/` → `TO`. */
const VTEC_PHENOMENON = /^\/[OTEX]\.[A-Z]{3}\.[A-Z]{4}\.([A-Z]{2})\.[WAYSFON]\./;

/**
 * The codes of one alert, most specific list first: a DWD event code names
 * the hazard and its strength, the Canadian profile's event and a VTEC
 * phenomenon name the hazard, a MeteoAlarm awareness type its group, and a
 * SAME code last, because NWS sends a generic one (`SVS`) on the updates of
 * a tornado warning.
 */
function capCodes(eventCodes: readonly CapPair[], parameters: readonly CapPair[]): string[] {
  const codes: string[] = [];
  for (const e of eventCodes) if (e.valueName === "II") codes.push(`II:${e.value.trim()}`);
  for (const e of eventCodes) {
    if (!e.valueName.startsWith("profile:CAP-CP:Event:")) continue;
    const code = CAP_CP_CODES.get(e.value.trim().toLowerCase());
    if (code !== undefined) codes.push(`CAP-CP:${code}`);
  }
  for (const p of parameters) {
    const m = p.valueName === "VTEC" ? VTEC_PHENOMENON.exec(p.value.trim()) : null;
    if (m !== null) codes.push(`VTEC:${m[1]}`);
  }
  for (const p of parameters) {
    if (p.valueName === "awareness_type")
      codes.push(`awareness_type:${p.value.split(";")[0]!.trim()}`);
  }
  for (const e of eventCodes) if (e.valueName === "SAME") codes.push(`SAME:${e.value.trim()}`);
  return codes;
}

/**
 * An alert's classification from its CAP event codes and parameters: the
 * first code a publisher list maps to a hazard. Undefined when none does
 * (a catch-all code, a list the registry does not know); the alert is then
 * `alert.other`, and its `event` text says what it is.
 */
export function capClassification(
  eventCodes: readonly CapPair[],
  parameters: readonly CapPair[] = [],
): SituationClass | undefined {
  for (const code of capCodes(eventCodes, parameters)) {
    const c = hazardsCrosswalk.situation("cap", code);
    if (c !== undefined) return c;
  }
  return undefined;
}
