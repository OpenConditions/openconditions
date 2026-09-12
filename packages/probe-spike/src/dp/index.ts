/**
 * DP release-glue spike (Artifact B). Proves GLUE correctness — data-independent
 * control flow, clamp + contribution bounding, private partition selection,
 * tumbling windows, idempotent retry, fail-closed per-unit budget — behind the
 * `DpMechanism` boundary. Makes NO differential-privacy guarantee; the noise and
 * the (ε,δ)/RDP/zCDP accounting are the real library's responsibility.
 */

export { BudgetLedger, type UnitBudget, type UnitSpend } from "./budget.js";
export {
  buildReleaseManifest,
  listPartitions,
  OverlappingWindowError,
  type Partition,
  partitionKey,
  type ReleaseManifest,
  type ReleaseManifestConfig,
  type ReleaseWindow,
  windowForTimestamp,
} from "./manifest.js";
export {
  type BoundedSumCall,
  controlProjection,
  type DpMechanism,
  type MechanismCall,
  type MechanismControlProjection,
  RecordingDpMechanism,
  type RecordingMechanismConfig,
  type SelectPartitionCall,
} from "./mechanism.js";
export {
  plannedPartitions,
  type ReleasedRow,
  type ReleaseFaults,
  type ReleaseParams,
  type ReleaseResult,
  ReleaseStore,
  releaseWithDp,
  SPEED_PUBLIC_LOWER,
  SPEED_PUBLIC_UPPER,
  type SpeedTuple,
  type SuppressedCell,
} from "./release.js";
