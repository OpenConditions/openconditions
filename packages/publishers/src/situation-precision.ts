import { situationEffects } from "@openconditions/model";

type Rec = Record<string, unknown>;
/** These XML projections reduce locations without carrying uncertainty. Never
 * publish a coarse location as an exact traffic restriction for other clients.
 * Undefined precision is retained for the emitters' legacy draft callers. */
export function hasCoarseLocation(situation: Rec): boolean {
  const coarse = (location: { fuzziness?: unknown } | undefined) =>
    location?.fuzziness !== undefined && location.fuzziness !== "exact";
  return (
    coarse(situation["location"] as { fuzziness?: unknown } | undefined) ||
    situationEffects(situation).some((effect) => coarse(effect.location))
  );
}
