/**
 * Closures a source opens to local access in words only: German "Anlieger
 * frei", English "local traffic only", Dutch "uitgezonderd
 * bestemmingsverkeer", French "sauf desserte locale". Each phrase pairs the
 * group with the word that excepts it, so a street named Anliegerstraße or
 * "Zufahrt bis Tankstelle frei" never reads as one.
 */
export interface LocalAccessException {
  usage: "local_access" | "residents";
  /** The phrase as the source wrote it. */
  phrase: string;
}

/** "kein Anliegerverkehr möglich" denies the exception it names. */
const NOT_DENIED = "(?<!(?:kein|keine|keinen|keinerlei|nicht)\\s+)";
const LOCAL = `${NOT_DENIED}(?<!\\p{L})anlieger(?:verkehr)?`;
const RESIDENTS = `${NOT_DENIED}(?<!\\p{L})anwohner(?:innen|verkehr)?`;

const group = (who: string) => [
  `${who}\\s+(?:ist\\s+|sind\\s+)?(?:weiterhin\\s+)?(?:frei|möglich|gestattet|zugelassen|ausgenommen)`,
  `frei\\s+für\\s+${who}`,
  `(?:außer|ausser|ausgenommen)\\s+(?:für\\s+)?${who}`,
  `nur\\s+(?:für\\s+)?${who}`,
];

const PATTERNS: [LocalAccessException["usage"], RegExp][] = [
  ["residents", new RegExp(group(RESIDENTS).join("|"), "iu")],
  [
    "residents",
    /residents\s+only|except\s+(?:for\s+)?residents|sauf\s+riverains|uitgezonderd\s+bewoners/iu,
  ],
  ["local_access", new RegExp(group(LOCAL).join("|"), "iu")],
  [
    "local_access",
    /local\s+(?:access|traffic)\s+only|except\s+(?:for\s+)?(?:local\s+)?(?:access|local\s+traffic)(?!\s+(?:by|for|to)\b)|(?:uitgezonderd|alleen|behalve)\s+bestemmingsverkeer|sauf\s+(?:desserte\s+locale|ayants\s+droit)/iu,
  ],
];

const UP_TO = /^\s*,?\s*(?:bis|up\s+to|tot)\b/iu;

/** The local-access exception the first text stating one states. */
export function localAccessExceptionOf(
  texts: readonly (string | undefined)[],
): LocalAccessException | undefined {
  for (const text of texts) {
    if (!text) continue;
    for (const [usage, pattern] of PATTERNS) {
      const match = pattern.exec(text);
      // "Anlieger frei bis Baustelle" opens the road only up to a point the
      // closure's geometry does not mark: the closure stays one for every car.
      if (match && !UP_TO.test(text.slice(match.index + match[0].length))) {
        return { usage, phrase: match[0] };
      }
    }
  }
  return undefined;
}
