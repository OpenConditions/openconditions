export interface FreshnessResult {
  isStale: boolean;
  ageSeconds: number;
}

/**
 * Returns true when the data is older than windowSec seconds relative to now.
 * Stale when age ≥ windowSec (boundary-inclusive).
 */
export function isStale(
  dataUpdatedAt: string,
  windowSec: number,
  now: Date = new Date(),
): boolean {
  const updatedMs = new Date(dataUpdatedAt).getTime();
  const ageMs = now.getTime() - updatedMs;
  return ageMs >= windowSec * 1000;
}

/**
 * Returns both an isStale flag and the age in seconds at the given moment.
 */
export function freshnessNow(
  dataUpdatedAt: string,
  windowSec: number,
  now: Date = new Date(),
): FreshnessResult {
  const updatedMs = new Date(dataUpdatedAt).getTime();
  const ageMs = now.getTime() - updatedMs;
  const ageSeconds = Math.floor(ageMs / 1000);
  return { isStale: ageSeconds >= windowSec, ageSeconds };
}
