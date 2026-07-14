/**
 * DP release-glue spike (Artifact B). Proves GLUE correctness — data-independent
 * control flow, clamp + contribution bounding, private partition selection,
 * tumbling windows, idempotent retry, fail-closed per-unit budget — behind the
 * `DpMechanism` boundary. Makes NO differential-privacy guarantee; the noise and
 * the (ε,δ)/RDP/zCDP accounting are the real library's responsibility.
 */
export {
  type DpMechanism,
  type BoundedSumCall,
  type SelectPartitionCall,
  type MechanismCall,
  type MechanismControlProjection,
  type RecordingMechanismConfig,
  controlProjection,
  RecordingDpMechanism,
} from "./mechanism.js";
export {
  type ReleaseWindow,
  type ReleaseManifest,
  type ReleaseManifestConfig,
  type Partition,
  OverlappingWindowError,
  buildReleaseManifest,
  listPartitions,
  partitionKey,
  windowForTimestamp,
} from "./manifest.js";
export { type UnitSpend, type UnitBudget, BudgetLedger } from "./budget.js";
export {
  type SpeedTuple,
  type ReleasedRow,
  type SuppressedCell,
  type ReleaseResult,
  type ReleaseParams,
  type ReleaseFaults,
  SPEED_PUBLIC_LOWER,
  SPEED_PUBLIC_UPPER,
  ReleaseStore,
  releaseWithDp,
  plannedPartitions,
} from "./release.js";
