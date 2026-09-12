/**
 * Canonicalize a Digitraffic *enum* token. v1 published `SINGLE_LANE_CLOSED`;
 * v2 publishes `single lane closed`, so both editions normalize to one form.
 * Applied only to known enum fields — never to descriptions or free text.
 *
 * It lives in its own module because the event parser and the restriction
 * normalizer both need it and the parser already depends on the normalizer.
 */
export function normalizeDtToken(value: string): string {
  return value.trim().replaceAll(" ", "_").replaceAll("-", "_").toUpperCase();
}
