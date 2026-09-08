/**
 * Per-sample candidate scoring: how well one directed spine segment explains
 * one sampled point of an event geometry. Distance, heading agreement, road
 * reference and road class each contribute; the path step consumes the result.
 */

const HIGHWAY_PRIOR: Record<string, number> = {
  motorway: 1.0,
  trunk: 0.95,
  primary: 0.9,
  motorway_link: 0.85,
  trunk_link: 0.82,
  primary_link: 0.8,
};

/** Preference for the road class a candidate carries; unknown classes sit at 0.8. */
export function highwayPrior(highway: string): number {
  return HIGHWAY_PRIOR[highway] ?? 0.8;
}

/**
 * Per-candidate score in [0, 1]: 0.4·offset + 0.3·bearing + 0.2·ref + 0.1·class.
 * Bearing: 1 up to 30°, linear to 0 at 90°, disqualifying (returns 0) beyond.
 * Point samples have no bearing; its weight is folded into offset (0.7·offset).
 */
export function scoreCandidate(
  c: { offsetM: number; bearingDelta: number | null; refScore: number; highway: string },
  maxOffsetM: number
): number {
  const offset = Math.max(0, 1 - c.offsetM / maxOffsetM);
  const cls = highwayPrior(c.highway);
  if (c.bearingDelta == null) return 0.7 * offset + 0.2 * c.refScore + 0.1 * cls;
  if (c.bearingDelta > 90) return 0;
  const bearing = c.bearingDelta <= 30 ? 1 : 1 - (c.bearingDelta - 30) / 60;
  return 0.4 * offset + 0.3 * bearing + 0.2 * c.refScore + 0.1 * cls;
}
