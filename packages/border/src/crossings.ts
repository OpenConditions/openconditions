import snapshot from "./snapshots/crossings.json" with { type: "json" };

/**
 * One border crossing of the vendored table: where it is, and the ports that
 * report its queues. Neither border agency publishes coordinates, so the
 * place is its Wikidata item's (label and coordinate location, CC0); which
 * item a port is, and the IANA zone it keeps its clocks in, are curated here.
 */
export interface BorderCrossing {
  /** The Wikidata item of the crossing (`Q<digits>`). */
  wikidata: string;
  /** The item's English label. */
  name: string;
  lon: number;
  lat: number;
  /** The two countries the crossing joins. */
  countries: readonly string[];
  /** The zone the port's wall-clock times are in. */
  zone: string;
  /** The CBP port numbers reporting the crossing's U.S.-bound queues. */
  cbp: readonly string[];
  /** The CBSA customs office names reporting its Canada-bound queues, as CBSA's CSV writes them. */
  cbsa: readonly string[];
}

/**
 * The vendored table: the crossings with their source and when their places
 * were read. Regenerated with `pnpm tsx scripts/gen-border-crossings.ts`.
 */
export interface BorderCrossingSnapshot {
  source: string;
  license: string;
  retrievedAt: string | null;
  crossings: readonly BorderCrossing[];
}

export const BORDER_CROSSINGS = snapshot as BorderCrossingSnapshot;

function index(key: "cbp" | "cbsa"): ReadonlyMap<string, BorderCrossing> {
  const byKey = new Map<string, BorderCrossing>();
  for (const crossing of BORDER_CROSSINGS.crossings) {
    for (const id of crossing[key]) byKey.set(id, crossing);
  }
  return byKey;
}

const BY_CBP_PORT = index("cbp");
const BY_CBSA_OFFICE = index("cbsa");

/** The crossing a CBP port number reports, matched exactly (CBP writes `L01901` and `l24501`). */
export function crossingOfCbpPort(port: string): BorderCrossing | undefined {
  return BY_CBP_PORT.get(port);
}

/** The crossing a CBSA office reports, by the office's name in CBSA's English CSV. */
export function crossingOfCbsaOffice(office: string): BorderCrossing | undefined {
  return BY_CBSA_OFFICE.get(office);
}
