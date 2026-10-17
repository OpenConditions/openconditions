/**
 * NWS's Primary Valid Time Event Code (P-VTEC, NWS Directive 10-1703), which
 * NWS sends as the `VTEC` parameter of its CAP alerts:
 * `/k.aaa.cccc.pp.s.####.yymmddThhnnZ-yymmddThhnnZ/`.
 */

/** Operational, test, experimental, and experimental VTEC in an operational product. */
export const VTEC_PRODUCT_CLASSES = ["O", "T", "E", "X"] as const;

/**
 * What a product does to its event: a new event, one continued, extended in
 * time, in area or in both, upgraded to a higher hazard, cancelled, expired,
 * a correction, and a routine product.
 */
export const VTEC_ACTIONS = [
  "NEW",
  "CON",
  "EXT",
  "EXA",
  "EXB",
  "UPG",
  "CAN",
  "EXP",
  "COR",
  "ROU",
] as const;

/** Warning, watch, advisory, statement, forecast, outlook, synopsis. */
export const VTEC_SIGNIFICANCES = ["W", "A", "Y", "S", "F", "O", "N"] as const;

/** The actions after which the event, as this code names it, is no longer in force. */
export const VTEC_ENDING_ACTIONS: ReadonlySet<string> = new Set(["UPG", "CAN", "EXP"]);

export interface Vtec {
  productClass: (typeof VTEC_PRODUCT_CLASSES)[number];
  action: (typeof VTEC_ACTIONS)[number];
  office: string;
  phenomenon: string;
  significance: (typeof VTEC_SIGNIFICANCES)[number];
  /** The event tracking number, unique per office, phenomenon and significance in a year. */
  eventNumber: number;
  /** Undefined when the event is already under way (`000000T0000Z`). */
  begin?: string;
  /** Undefined when the event lasts until further notice. */
  end?: string;
}

const PATTERN =
  /^\/([OTEX])\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.(\d{6}T\d{4}Z)-(\d{6}T\d{4}Z)\/$/;

/** `yymmddThhnnZ` as an ISO instant; undefined for the zero time and for a date that does not exist. */
function vtecTime(text: string): string | undefined {
  if (text === "000000T0000Z") return undefined;
  const iso = `20${text.slice(0, 2)}-${text.slice(2, 4)}-${text.slice(4, 6)}T${text.slice(7, 9)}:${text.slice(9, 11)}:00Z`;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) || at.toISOString() !== iso.replace(":00Z", ":00.000Z")
    ? undefined
    : iso;
}

/**
 * One P-VTEC string read; `unknown` when it has VTEC's shape but an action
 * or significance the directive does not define, null when it is no P-VTEC
 * string at all.
 */
export function nwsVtec(text: string): Vtec | "unknown" | null {
  const m = PATTERN.exec(text.trim());
  if (m === null) return null;
  const [, k, action, office, phenomenon, significance, etn, begin, end] = m as unknown as [
    string,
    Vtec["productClass"],
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (
    !(VTEC_ACTIONS as readonly string[]).includes(action) ||
    !(VTEC_SIGNIFICANCES as readonly string[]).includes(significance)
  ) {
    return "unknown";
  }
  const from = vtecTime(begin);
  const to = vtecTime(end);
  return {
    productClass: k,
    action: action as Vtec["action"],
    office,
    phenomenon,
    significance: significance as Vtec["significance"],
    eventNumber: Number(etn),
    ...(from === undefined ? {} : { begin: from }),
    ...(to === undefined ? {} : { end: to }),
  };
}
